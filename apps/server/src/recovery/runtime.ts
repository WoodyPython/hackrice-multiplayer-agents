import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createDb, type DbHandle } from '../db/client.js';
import { buildApp, defaultBlobStore, type AppDeps } from '../http/app.js';
import { LocalGitService } from '../git/service.js';
import { GitWorkspaceLifecycleHook } from '../git/lifecycle.js';
import { GitRuntimeError } from '../git/command.js';
import { PgDraftStore } from '../drafts/store.js';
import { attachLiveDocuments } from '../collaboration/server.js';
import { LiveDocumentCoordinator } from '../collaboration/coordinator.js';
import { PgCheckpointStore } from '../collaboration/checkpoint-store.js';
import { registerCheckpointRoutes } from '../collaboration/routes.js';
import { PgMaterialService } from '../materials/service.js';
import { PgAgentLedger } from '../agents/ledger.js';
import { createGeminiAdapter } from '../models/gemini.js';
import { ModelAdapterError, type ModelAdapter } from '../models/types.js';
import { OrchestratorPlanner, ParallelAssignmentScheduler, StartOrchestrator } from '../orchestration/index.js';
import { WorkerExecutor } from '../workers/executor.js';

export interface LiveDocumentAttachment {
  close(): Promise<void>;
}

/** D03 supplies the room server here, attached before the single HTTP listen. */
export type AttachLiveDocuments = (server: Server) => Promise<LiveDocumentAttachment>;

export interface RuntimeOptions {
  config: AppConfig;
  attachLiveDocuments?: AttachLiveDocuments;
  createDatabase?: (url: string) => DbHandle;
  applicationFactory?: (deps: AppDeps) => Promise<FastifyInstance>;
  /** Allows tests to use port 0 and an ephemeral, loopback-only listener. */
  listen?: { host: string; port: number };
}

export async function startRuntime(options: RuntimeOptions) {
  const { config } = options;
  const git = new LocalGitService(config.gitDataRoot);
  let db: DbHandle | undefined;
  let app: FastifyInstance | undefined;
  let live: LiveDocumentAttachment | undefined;
  let collaboration: LiveDocumentCoordinator | undefined;
  let orchestration: StartOrchestrator | undefined;
  let closing: Promise<void> | undefined;
  const lifecycle = new GitWorkspaceLifecycleHook(git, (fields) => {
    app?.log.error(fields, 'repository initialization failed; first access will retry');
  });

  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        let failed = false;
        // Close upgraded connections first, while the database still exists.
        // Every cleanup runs even if a previous cleanup rejected.
        for (const cleanup of [
          // Stop dispatching before the sockets and database go away, so an
          // in-flight run's last writes are not aborted mid-transaction.
          () => orchestration?.close(),
          () => live?.close(),
          () => collaboration?.close(),
          () => app?.close(),
          () => lifecycle.drain(),
          () => db?.close(),
        ]) {
          try { await cleanup(); } catch { failed = true; }
        }
        if (failed) throw new GitRuntimeError('SHUTDOWN_FAILED');
      })();
    }
    return closing;
  };

  try {
    await git.prepare();
    db = (options.createDatabase ?? createDb)(config.DATABASE_URL);
    // Do not report healthy until the configured database is reachable.
    await db.pool.query('select 1');
    const drafts = new PgDraftStore({ db: db.db });
    const liveDeps = { drafts, git,
      onError: (fields: { draftFileId: string; code: 'DRAFT_NOT_SAVED' }) =>
        app?.log.error(fields, 'shared draft persistence failed; retrying'),
    };
    // Built before the application because Start orchestration captures the
    // human draft through this same coordinator; a second one for the same
    // runtime would capture a different set of rooms.
    collaboration = new LiveDocumentCoordinator(liveDeps, {
      drafts, git, checkpoints: new PgCheckpointStore(db.db),
    });
    orchestration = buildOrchestration({
      config, db: db.db, git, drafts, collaboration,
      onBackgroundError: (error) => app?.log.error({ err: error }, 'orchestration failed outside a request'),
    });
    app = await (options.applicationFactory ?? buildApp)({ db: db.db, config, lifecycle, orchestration });
    await registerCheckpointRoutes(app, collaboration);
    live = options.attachLiveDocuments
      ? await options.attachLiveDocuments(app.server)
      : attachLiveDocuments(app.server, liveDeps, collaboration);
    // D03 snapshot loads remain on demand. Later recovery tickets reconcile
    // previous boots and pending applies here, before accepting task actions.
    if (!config.GEMINI_API_KEY?.trim()) {
      // Everything except agent execution still works; say so once, at boot,
      // rather than only per Start in a task event nobody is watching yet.
      app.log.warn('GEMINI_API_KEY is not configured; each Start will end its run as model_configuration');
    }
    orchestration.open();
    await app.listen(options.listen ?? { host: '0.0.0.0', port: config.PORT });
    return { app, git, lifecycle, collaboration, orchestration, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error instanceof GitRuntimeError ? error : new GitRuntimeError('STARTUP_FAILED');
  }
}

/**
 * The one place Role C's execution stack is assembled (design section 15.1).
 *
 * Every component here is a per-runtime singleton on purpose: one ledger writes
 * `task_agent_budgets`, one scheduler holds the per-workspace queues, and one
 * executor owns the in-flight worker map. A second set against the same data
 * root would produce two coordinators racing for the same runs.
 */
function buildOrchestration(deps: {
  config: AppConfig;
  db: DbHandle['db'];
  git: LocalGitService;
  drafts: PgDraftStore;
  collaboration: LiveDocumentCoordinator;
  onBackgroundError: (error: unknown) => void;
}): StartOrchestrator {
  const { config, db, git, onBackgroundError } = deps;
  const bootId = config.bootId;
  const ledger = new PgAgentLedger({ db, bootId });
  const adapter = configuredAdapter(config);
  const materials = new PgMaterialService({ db, blobs: defaultBlobStore(config) });
  const workers = new WorkerExecutor({ db, ledger, adapter, git, materials, onBackgroundError });
  return new StartOrchestrator({
    db, bootId, ledger, adapter, git, materials,
    drafts: deps.drafts, collaboration: deps.collaboration, onBackgroundError,
    planner: new OrchestratorPlanner({ db, ledger, adapter, bootId, onBackgroundError }),
    scheduler: new ParallelAssignmentScheduler({ db, bootId, ledger, adapter, workers, git }),
  });
}

/**
 * Without a provider key the process still serves the workspace, the editor and
 * reviews; only agent execution is unavailable. Reporting that per Start is
 * better than refusing to boot, and far better than a silent hook that leaves
 * every started run sitting in `planning` with nothing behind it.
 */
function configuredAdapter(config: AppConfig): ModelAdapter {
  try {
    return createGeminiAdapter(config);
  } catch {
    const refuse = (): never => {
      throw new ModelAdapterError('configuration', 'GEMINI_API_KEY is required for agent execution.');
    };
    return { getModel: refuse, countInput: refuse, generate: refuse };
  }
}

export function registerShutdownSignals(
  close: () => Promise<void>,
  signals: Pick<NodeJS.Process, 'on' | 'off'> = process,
  reportFailure: () => void = () => {
    console.error('Runtime shutdown failed.');
    process.exitCode = 1;
  },
): () => void {
  let stopping = false;
  const dispose = () => {
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve().then(close).catch(reportFailure).finally(dispose);
  };
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  return dispose;
}

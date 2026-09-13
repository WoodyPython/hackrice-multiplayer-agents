import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createDb, type DbHandle } from '../db/client.js';
import { buildApp, defaultBlobStore, type AppDeps } from '../http/app.js';
import { LocalGitService } from '../git/service.js';
import { GitWorkspaceLifecycleHook } from '../git/lifecycle.js';
import { GitRuntimeError } from '../git/command.js';
import { PgDraftStore } from '../drafts/store.js';
import { attachLiveDocuments } from '../collaboration/server.js';
import { readSessionCookie } from '../auth/authorize.js';
import { LiveDocumentCoordinator } from '../collaboration/coordinator.js';
import { PgCheckpointStore } from '../collaboration/checkpoint-store.js';
import { registerCheckpointRoutes } from '../collaboration/routes.js';
import { PgMaterialService } from '../materials/service.js';
import { PgAgentLedger } from '../agents/ledger.js';
import { createGeminiAdapter, setProviderDiagnostic } from '../models/gemini.js';
import { ModelAdapterError, type ModelAdapter } from '../models/types.js';
import { OrchestratorPlanner, ParallelAssignmentScheduler, StartOrchestrator,
  ReviewAssessor, ReviewEvidenceComposer } from '../orchestration/index.js';
import { WorkerExecutor } from '../workers/executor.js';
import { LocalReviewService } from '../reviews/service.js';
import { registerReviewRoutes } from '../reviews/routes.js';
import { ApiError, canWrite } from '@app/contracts';
import { PgRunStore } from '../runs/run-store.js';
import { registerFrontend } from '../http/frontend.js';
import { registerApprovedFileRoutes } from '../git/routes.js';
import type { ExecutionDeps } from '../agents/execution.js';
import { BriefingService } from '../briefings/service.js';
import { registerBriefingRoutes } from '../briefings/routes.js';
import { AgentHistoryService } from '../agent-history/service.js';
import { registerAgentHistoryRoutes } from '../agent-history/routes.js';

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
  /** Dependency injection for deterministic tests of the complete runtime. */
  modelAdapter?: ModelAdapter;
  frontendRoot?: string;
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
    const interrupted = await new PgRunStore({ db: db.db, bootId: config.bootId }).markInterruptedFromPreviousBoots();
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
    const adapter = options.modelAdapter ?? configuredAdapter(config);
    orchestration = buildOrchestration({
      config, db: db.db, git, drafts, collaboration, adapter,
      onBackgroundError: (error) => app?.log.error({ err: error }, 'orchestration failed outside a request'),
      // What each model call counted, was granted, and actually billed. A
      // `token_exhausted` agent otherwise says nothing about which of the three
      // went wrong.
      onAccounting: (info) => app?.log.info(info, 'model call accounting'),
    });
    app = await (options.applicationFactory ?? buildApp)({ db: db.db, config, lifecycle, orchestration });

    /*
     * Send the provider's own account of a failure to the process log.
     *
     * Must come after `app` exists: an earlier version set this from inside
     * configuredAdapter, which runs before the server is built, so the logger
     * was always undefined and nothing was ever reported. Server-side only —
     * section 13.3 governs what reaches the browser, and the adapter strips
     * anything credential-shaped before calling this.
     */
    setProviderDiagnostic(({ model, status, detail }) => {
      app?.log.error({ model, status, detail }, 'gemini request failed');
    });
    await registerFrontend(app, options.frontendRoot ?? fileURLToPath(new URL('../../../web/dist/', import.meta.url)), config.isProduction);
    await registerApprovedFileRoutes(app, { db: db.db, git });
    await registerAgentHistoryRoutes(app, new AgentHistoryService({ db: db.db, git }));
    await registerCheckpointRoutes(app, collaboration);
    const database = db.db;
    collaboration.checkUnloaded = async (taskId, revisions) => {
      const task = await database.selectFrom('tasks').select('status').where('id', '=', taskId).executeTakeFirst();
      if (!task || task.status === 'completed') return false;
      const rows = await database.selectFrom('draft_files').select(['id', 'persisted_revision']).where('task_id', '=', taskId).where('status', '=', 'active').execute();
      return rows.length === Object.keys(revisions).length && rows.every((row) => revisions[row.id] === row.persisted_revision);
    };
    collaboration.persistClosure = async (taskId) => {
      const task = await database.selectFrom('tasks').select('workspace_id').where('id', '=', taskId).executeTakeFirstOrThrow();
      await drafts.closeEpoch(task.workspace_id, taskId);
    };
    collaboration.assertWritable = async (taskId) => {
      const task = await database.selectFrom('tasks').select('status').where('id', '=', taskId).executeTakeFirst();
      if (!task || task.status === 'completed') throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      const pending = await database.selectFrom('apply_operations').innerJoin('reviews', 'reviews.id', 'apply_operations.review_id')
        .select('apply_operations.id').where('reviews.task_id', '=', taskId).where('apply_operations.status', 'in', ['pending', 'ambiguous']).executeTakeFirst();
      if (pending) throw new ApiError('RUN_INTERRUPTED', 'An apply operation must be reconciled before editing.');
    };
    const reviews = new LocalReviewService({ db: db.db, git, collaboration, bootId: config.bootId });
    collaboration.onAcceptedChange = (taskId, revisionMark) => reviews.invalidate({ taskId, reason: revisionMark });
    // C07: a fresh assessment reads the review's own current candidate rather
    // than any run, so it needs only the review reader, not the Git service.
    const reviewAssessments = new ReviewAssessor({ db: db.db, adapter, reviews,
      onBackgroundError: (error) => app?.log.error({ err: error }, 'review usage settlement failed after timeout') });
    const reviewEvidence = new ReviewEvidenceComposer({ db: db.db });
    await registerReviewRoutes(app, reviews, { evidence: reviewEvidence, assessments: reviewAssessments });
    // "Catch me up": the same adapter as agents, so the key stays server-side
    // and a missing key degrades to the factual recap rather than an error.
    const briefings = new BriefingService({
      db: db.db, adapter,
      sources: {
        approvedPaths: async (workspaceId) =>
          new Set((await git.listApprovedFiles(workspaceId)).files.map((file) => file.path)),
        reviewChangedPaths: async (workspaceId, reviewId) =>
          (await reviews.read(workspaceId, reviewId)).changedFiles.map((file) => file.path),
      },
      onModelFailure: (info) => app?.log.warn(info, 'briefing fell back to the activity recap'),
    });
    await registerBriefingRoutes(app, { briefings });
    const applies = await reviews.reconcilePreviousApplies();
    const recovery = { interrupted, applies };
    app.log.info({ recovery }, 'startup recovery complete');
    live = options.attachLiveDocuments
      ? await options.attachLiveDocuments(app.server)
      : attachLiveDocuments(app.server, liveDeps, collaboration, async ({ workspaceId, cookie }) => {
        // Membership, not link possession: holding a room URL is not permission
        // to edit the document in it.
        const identity = await app!.sessions.resolve(readSessionCookie(cookie));
        const access = await app!.sessions.access(workspaceId, identity?.userId);
        if (!canWrite(access)) {
          throw new ApiError(identity ? 'FORBIDDEN' : 'AUTH_REQUIRED',
            identity ? 'Join this workspace to edit its documents.' : 'Sign in to edit this document.');
        }
      });
    // Persisted documents and Git worktree projections restore on demand.
    if (!options.modelAdapter && !config.GEMINI_API_KEY?.trim()) {
      // Everything except agent execution still works; say so once, at boot,
      // rather than only per Start in a task event nobody is watching yet.
      app.log.warn('GEMINI_API_KEY is not configured; each Start will end its run as model_configuration');
    }
    orchestration.open();
    await app.listen(options.listen ?? { host: '0.0.0.0', port: config.PORT });
    return { app, git, lifecycle, collaboration, orchestration, reviews, reviewAssessments, reviewEvidence, recovery, close };
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
  adapter: ModelAdapter;
  onBackgroundError: (error: unknown) => void;
  onAccounting?: ExecutionDeps['onAccounting'];
}): StartOrchestrator {
  const { config, db, git, adapter, onBackgroundError, onAccounting } = deps;
  const bootId = config.bootId;
  const ledger = new PgAgentLedger({ db, bootId });
  const materials = new PgMaterialService({ db, blobs: defaultBlobStore(config) });
  const workers = new WorkerExecutor({ db, ledger, adapter, git, materials, onBackgroundError, onAccounting });
  return new StartOrchestrator({
    db, bootId, ledger, adapter, git, materials,
    drafts: deps.drafts, collaboration: deps.collaboration, onBackgroundError,
    planner: new OrchestratorPlanner({ db, ledger, adapter, bootId, onBackgroundError, onAccounting }),
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

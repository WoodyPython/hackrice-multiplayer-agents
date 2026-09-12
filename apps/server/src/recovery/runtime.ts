import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createDb, type DbHandle } from '../db/client.js';
import { buildApp, type AppDeps } from '../http/app.js';
import { LocalGitService } from '../git/service.js';
import { GitWorkspaceLifecycleHook } from '../git/lifecycle.js';
import { GitRuntimeError } from '../git/command.js';
import { PgDraftStore } from '../drafts/store.js';
import { attachLiveDocuments } from '../collaboration/server.js';
import { LiveDocumentCoordinator } from '../collaboration/coordinator.js';
import { PgCheckpointStore } from '../collaboration/checkpoint-store.js';
import { registerCheckpointRoutes } from '../collaboration/routes.js';
import { LocalReviewService } from '../reviews/service.js';
import { registerReviewRoutes } from '../reviews/routes.js';
import { ApiError } from '@app/contracts';

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
    app = await (options.applicationFactory ?? buildApp)({ db: db.db, config, lifecycle });
    const drafts = new PgDraftStore({ db: db.db });
    const liveDeps = { drafts, git,
      onError: (fields: { draftFileId: string; code: 'DRAFT_NOT_SAVED' }) =>
        app?.log.error(fields, 'shared draft persistence failed; retrying'),
    };
    collaboration = new LiveDocumentCoordinator(liveDeps, {
      drafts, git, checkpoints: new PgCheckpointStore(db.db),
    });
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
    await registerReviewRoutes(app, reviews);
    live = options.attachLiveDocuments
      ? await options.attachLiveDocuments(app.server)
      : attachLiveDocuments(app.server, liveDeps, collaboration);
    // D03 snapshot loads remain on demand. Later recovery tickets reconcile
    // previous boots and pending applies here, before accepting task actions.
    await app.listen(options.listen ?? { host: '0.0.0.0', port: config.PORT });
    return { app, git, lifecycle, collaboration, reviews, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error instanceof GitRuntimeError ? error : new GitRuntimeError('STARTUP_FAILED');
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

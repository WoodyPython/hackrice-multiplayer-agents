import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  NullOrchestrationHook,
  NullWorkspaceLifecycleHook,
  OWNER_KEY_HEADER,
  type OrchestrationHook,
  type WorkspaceLifecycleHook,
} from '@app/contracts';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { PgWorkspaceService } from '../workspaces/service.js';
import { registerWorkspaceRoutes } from '../workspaces/routes.js';
import { PgDiscussionService } from '../discussion/service.js';
import { PgTaskService } from '../tasks/service.js';
import { PgReviewStore } from '../runs/review-store.js';
import { PgRunStore } from '../runs/run-store.js';
import { registerTaskRoutes } from '../tasks/routes.js';
import { PgMaterialService } from '../materials/service.js';
import { registerMaterialRoutes } from '../materials/routes.js';
import { PgDraftStore } from '../drafts/store.js';
import { registerDraftRoutes } from '../drafts/routes.js';
import { TaskEventService } from '../events/service.js';
import { registerEventRoutes } from '../events/routes.js';
import { RecordingBroadcaster, SupabaseBroadcaster, type Broadcaster } from '../events/broadcaster.js';
import { TaskEventPump } from '../events/pump.js';
import type { BlobStore } from '../materials/blob-store.js';
import { LocalDiskBlobStore, SupabaseBlobStore } from '../materials/blob-store.js';
import { registerErrorHandler } from './errors.js';
import { registerFrontend } from './frontend.js';
import { supabaseServerKey } from '../supabase-auth.js';

/**
 * The application factory (design section 15.1).
 *
 * Owned by Role B. Returns a configured server that listens to nothing and owns
 * no process state — no boot sequence, no Git data root, no sockets. Role D's
 * apps/server/src/index.ts is what turns this into a running process: it loads
 * configuration, prepares the Git root, attaches the Yjs server to the same
 * HTTP server, and listens.
 *
 * Roles C and D mount their routes by adding registrations here or by passing
 * a plugin, so there is one server and one error contract.
 */

export interface AppDeps {
  db: Db;
  config: AppConfig;
  /** Role D implements this in D01. Defaults to a no-op recorder. */
  lifecycle?: WorkspaceLifecycleHook;
  /** Role C implements this in C06. Defaults to a no-op recorder. */
  orchestration?: OrchestrationHook;
  /**
   * Where material bytes live. Defaults to local disk so the server runs
   * without a Supabase project; swap in SupabaseBlobStore at deploy time.
   */
  blobs?: BlobStore;
  /**
   * Refresh-hint transport. Defaults to a recorder when no Supabase project is
   * configured, which is every local run; clients poll instead (section 5).
   */
  broadcaster?: Broadcaster;
  /**
   * Capture log output instead of writing to stdout. Exists so the redaction
   * rules below can be asserted rather than assumed: a test drives an owner
   * request through the app and checks the raw key never appears.
   */
  logStream?: NodeJS.WritableStream;
}

/**
 * Supabase Storage when a project is configured, local disk otherwise.
 *
 * Selected here rather than at the call site so a deployment gets object
 * storage by setting environment variables, with no code change. Local disk is
 * not a production target: it shares the persistent disk section 5.3 reserves
 * for Git and has no replication.
 */
export function defaultBlobStore(config: AppConfig): BlobStore {
  const serverKey = supabaseServerKey(config);
  if (config.SUPABASE_URL && serverKey) {
    return new SupabaseBlobStore({
      url: config.SUPABASE_URL,
      serviceRoleKey: serverKey,
      bucket: config.SUPABASE_STORAGE_BUCKET,
    });
  }
  return new LocalDiskBlobStore(join(config.gitDataRoot, 'materials'));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const serverKey = supabaseServerKey(config);

  const app = Fastify({
    logger: {
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      level:
        deps.logStream ? 'debug' : config.NODE_ENV === 'test' ? 'silent' : config.isProduction ? 'info' : 'debug',
      /**
       * Section 13.3: "Owner keys, model keys, Supabase service credentials,
       * and internal filesystem locations never enter document context or
       * generated work logs."
       *
       * Fastify logs request headers, so the owner key would otherwise appear
       * in plaintext on every owner operation. Response bodies are not logged,
       * which is what keeps the key out of the creation response's log line.
       */
      redact: {
        paths: [
          // Fastify's own req serializer already drops headers entirely, so the
          // key cannot reach a request log line through that path. These cover
          // every other realistic shape: a bare headers object, a context
          // wrapper around one, or the key by name in a body or a result.
          `req.headers["${OWNER_KEY_HEADER}"]`,
          `headers["${OWNER_KEY_HEADER}"]`,
          `*.headers["${OWNER_KEY_HEADER}"]`,
          'ownerKey',
          '*.ownerKey',
          '*.*.ownerKey',
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'req.headers["x-api-key"]',
        ],
        censor: '[redacted]',
      },
    },
    // Section 3.4's transport limit, applied to JSON bodies as well.
    bodyLimit: 1024 * 1024,
    trustProxy: config.isProduction,
    // No disableRequestLogging: it is deprecated in Fastify 5 and removed in 6,
    // and the silent level above already suppresses request logs under test.
  });

  /**
   * In production the built frontend is served by this same service (section
   * 5.3), so requests are same-origin. In development Vite runs on its own
   * port, so the app origin must be allowed explicitly.
   *
   * OWNER_KEY_HEADER is a non-simple header: without it in allowedHeaders the
   * browser's preflight fails and every owner operation dies with an opaque
   * CORS error rather than a useful one.
   */
  await app.register(cors, {
    origin: config.isProduction ? false : [config.PUBLIC_APP_URL, /^http:\/\/localhost:\d+$/],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', OWNER_KEY_HEADER],
    credentials: false,
    maxAge: 86_400,
  });

  /**
   * Registered globally but disabled by default, then enabled per route. Only
   * workspace creation is limited: section 9.4 forbids turning provider limits
   * into product rules, and throttling ordinary contribution would do exactly
   * that.
   */
  await app.register(rateLimit, { global: false });

  // Section 3.4's 1 MiB per-text-file transport limit, enforced at the parser
  // so an oversized body never reaches memory whole.
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024, files: 1, fields: 8 },
  });

  registerErrorHandler(app, !config.isProduction);

  app.get('/health', async () => ({
    status: 'ok',
    bootId: config.bootId,
  }));

  const workspaces = new PgWorkspaceService({
    db: deps.db,
    publicAppUrl: config.PUBLIC_APP_URL,
    lifecycle: deps.lifecycle ?? new NullWorkspaceLifecycleHook(),
    onLifecycleError: (error, workspaceId) => {
      // Not fatal: Role D's Git service ensures the repository on first access,
      // so this workspace repairs itself. Logged because a persistent failure
      // here means the Git data root is broken and Start will fail later.
      app.log.error(
        { err: error, workspaceId },
        'workspace lifecycle hook failed; repository will be created on first access',
      );
    },
  });

  await registerWorkspaceRoutes(app, {
    workspaces,
    createRateLimit: {
      max: config.WORKSPACE_CREATE_MAX,
      timeWindow: config.WORKSPACE_CREATE_WINDOW,
    },
  });

  const discussion = new PgDiscussionService({ db: deps.db });
  const tasks = new PgTaskService({
    db: deps.db,
    bootId: config.bootId,
    orchestration: deps.orchestration ?? new NullOrchestrationHook(),
    onOrchestrationError: (error, runId) => {
      // The Start response has already been sent. C06 is responsible for ending
      // the run in a terminal state with an event saying why; this only records
      // that the handoff itself threw.
      app.log.error({ err: error, runId }, 'orchestration hook failed');
    },
  });

  await registerTaskRoutes(app, {
    tasks,
    discussion,
    runs: new PgRunStore({ db: deps.db, bootId: config.bootId }),
    reviews: new PgReviewStore({ db: deps.db }),
  });

  const materials = new PgMaterialService({
    db: deps.db,
    blobs: deps.blobs ?? defaultBlobStore(config),
  });
  await registerMaterialRoutes(app, { materials });

  const drafts = new PgDraftStore({ db: deps.db });
  await registerDraftRoutes(app, { drafts });

  const broadcaster =
    deps.broadcaster ??
    (config.SUPABASE_URL && serverKey
      ? new SupabaseBroadcaster(
          { url: config.SUPABASE_URL, serviceRoleKey: serverKey },
          (error) => app.log.warn({ err: error }, 'refresh hint broadcast failed'),
        )
      : new RecordingBroadcaster());

  const events = new TaskEventService({ db: deps.db, broadcaster });
  await registerEventRoutes(app, { events, config });

  // Sweeps durable events and broadcasts hints. Started here and stopped with
  // the server so a caller that only builds an app for tests gets neither a
  // timer nor a background query loop it did not ask for.
  const pump = new TaskEventPump({
    db: deps.db,
    broadcaster,
    onError: (error) => app.log.warn({ err: error }, 'event pump sweep failed'),
  });
  app.decorate('eventPump', pump);
  app.addHook('onClose', async () => { await pump.stop(); });

  if (config.isProduction) await registerFrontend(app);
  return app;
}

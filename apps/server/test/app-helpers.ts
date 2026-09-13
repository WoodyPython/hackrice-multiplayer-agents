import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { NullOrchestrationHook, NullWorkspaceLifecycleHook } from '@app/contracts';
import type { BlobStore } from '../src/materials/blob-store.js';
import type { AppConfig } from '../src/config.js';
import { BOOT_ID } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { connectTestDb, ensureTestUser, sessionCookie, TEST_USER_EMAIL, TEST_USER_ID } from './helpers.js';
import type { DbHandle } from '../src/db/client.js';

export const TEST_APP_URL = 'http://localhost:5173';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgresql://unused',
    PUBLIC_APP_URL: TEST_APP_URL,
    GIT_DATA_ROOT: './data',
    ORCHESTRATOR_MODEL: 'gemini-2.5-pro',
    WORKER_MODEL: 'gemini-2.5-flash',
    // High enough that ordinary tests never trip it; the rate-limit test
    // overrides it explicitly.
    WORKSPACE_CREATE_MAX: 1000,
    WORKSPACE_CREATE_WINDOW: '1 minute',
    bootId: BOOT_ID,
    isProduction: false,
    gitDataRoot: join(tmpdir(), 'test-git-root'),
    ...overrides,
  };
}

/** Collects everything written to the logger so redaction can be asserted. */
export class LogCapture extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    cb();
  }

  text(): string {
    return this.chunks.join('');
  }
}

export interface TestApp {
  app: FastifyInstance;
  handle: DbHandle;
  lifecycle: NullWorkspaceLifecycleHook;
  orchestration: NullOrchestrationHook;
  logs: LogCapture | undefined;
  ownerUserId: string;
  ownerEmail: string;
  close(): Promise<void>;
}

/**
 * A verifier that never leaves the process.
 *
 * Sign-in is the one place that talks to Supabase. Tests assert OUR
 * authorization, so the provider is replaced by a stub that treats the token as
 * the email address; `permissions.test.ts` uses it to mint distinct callers.
 */
export function fakeVerifier() {
  return async (accessToken: string) => {
    const email = accessToken.includes('@') ? accessToken : `${accessToken}@example.test`;
    return {
      // Stable per email, so signing in twice is the same account.
      supabaseUserId: deterministicUuid(email),
      email,
      displayName: email.split('@')[0] ?? 'Member',
    };
  };
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join('-');
}

export async function buildTestApp(options: {
  config?: Partial<AppConfig>;
  captureLogs?: boolean;
  blobs?: BlobStore;
  /**
   * Attach the fixture owner's cookie to every request that does not bring its
   * own. Default true so the existing suites keep testing their own subject
   * rather than re-testing the authorization hook 177 times.
   *
   * `permissions.test.ts` passes false: a suite about who may do what must not
   * be handed an identity it did not ask for.
   */
  authenticate?: boolean;
  /** Registered before `ready()`, for tests that need a route of their own. */
  extraRoutes?: (app: FastifyInstance) => void;
} = {}): Promise<TestApp> {
  const handle = connectTestDb();
  const lifecycle = new NullWorkspaceLifecycleHook();
  const orchestration = new NullOrchestrationHook();
  const logs = options.captureLogs ? new LogCapture() : undefined;

  const app = await buildApp({
    db: handle.db,
    config: testConfig(options.config),
    lifecycle,
    orchestration,
    verifyIdentity: fakeVerifier(),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(logs ? { logStream: logs } : {}),
  });
  options.extraRoutes?.(app);
  await app.ready();

  if (options.authenticate !== false) {
    await ensureTestUser(handle.db);
    // Wrapping `inject` rather than editing 177 call sites. Deliberately only
    // fills in a cookie that is absent, so a test can still act as somebody
    // else -- or as nobody -- by supplying its own.
    const original = app.inject.bind(app);
    app.inject = ((opts?: Parameters<typeof original>[0]) => {
      if (opts && typeof opts === 'object') {
        const headers = (opts as { headers?: Record<string, unknown> }).headers ?? {};
        if (!('cookie' in headers)) {
          (opts as { headers?: Record<string, unknown> }).headers = { ...headers, ...sessionCookie() };
        }
      }
      return original(opts as never);
    }) as typeof app.inject;
  }

  return {
    app,
    handle,
    lifecycle,
    orchestration,
    logs,
    ownerUserId: TEST_USER_ID,
    ownerEmail: TEST_USER_EMAIL,
    async close() {
      await app.close();
      await handle.close();
    },
  };
}

/** Creates a workspace through the API and returns the parsed response. */
export async function createWorkspaceViaApi(
  app: FastifyInstance,
  body: Record<string, unknown> = { name: 'Launch prep' },
): Promise<{ workspaceId: string; contributionUrl: string; ownerKey: string | null }> {
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: body });
  if (res.statusCode !== 201) {
    throw new Error(`create failed ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

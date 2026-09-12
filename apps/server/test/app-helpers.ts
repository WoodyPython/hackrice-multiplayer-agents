import { Writable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { NullOrchestrationHook, NullWorkspaceLifecycleHook } from '@app/contracts';
import type { BlobStore } from '../src/materials/blob-store.js';
import type { AppConfig } from '../src/config.js';
import { BOOT_ID } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { connectTestDb } from './helpers.js';
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
  close(): Promise<void>;
}

export async function buildTestApp(options: {
  config?: Partial<AppConfig>;
  captureLogs?: boolean;
  blobs?: BlobStore;
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
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(logs ? { logStream: logs } : {}),
  });
  await app.ready();

  return {
    app,
    handle,
    lifecycle,
    orchestration,
    logs,
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
): Promise<{ workspaceId: string; contributionUrl: string; ownerKey: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: body });
  if (res.statusCode !== 201) {
    throw new Error(`create failed ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

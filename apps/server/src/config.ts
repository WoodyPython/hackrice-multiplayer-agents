import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Server configuration (design section 5.3).
 *
 * Every value here is server-only except PUBLIC_APP_URL and
 * SUPABASE_PUBLISHABLE_KEY. Nothing in this module may be serialized into an
 * API response, a document, model context, or a log line.
 */

/**
 * Identifies this process for the lifetime of the process.
 *
 * Runs and agent instances reference it from the moment they exist, and
 * section 14.4's startup routine uses it to mark work from a previous boot as
 * interrupted. Generated here rather than in the startup routine because
 * records need it long before recovery runs.
 *
 * Declared before env parsing so a configuration error cannot leave the process
 * without one.
 */
export const BOOT_ID: string = randomUUID();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /** Used to build the contribution URL. Public. */
  PUBLIC_APP_URL: z.string().url(),

  /** Role D's persistent Git data root. */
  GIT_DATA_ROOT: z.string().default('./data'),

  // Optional until B04 (Storage) and B06 (Realtime). Absent values are not an
  // error: local development works fully without a Supabase project.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** The one Supabase value that reaches the browser, for refresh channels. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  // Role C. Optional so B and D can run without a key.
  GEMINI_API_KEY: z.string().min(1).optional(),
  ORCHESTRATOR_MODEL: z.string().min(1).default('gemini-2.5-pro'),
  WORKER_MODEL: z.string().min(1).default('gemini-2.5-flash'),

  /**
   * Workspace creation guard (section 3.4). A transport and storage
   * constraint, not an agent quota: the endpoint is unauthenticated, nothing
   * lists workspaces, and each one occupies a repository on a fixed-size disk.
   */
  WORKSPACE_CREATE_MAX: z.coerce.number().int().positive().default(10),
  WORKSPACE_CREATE_WINDOW: z.string().default('1 hour'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  bootId: string;
  isProduction: boolean;
  /** Absolute, so nothing downstream resolves it against a drifting cwd. */
  gitDataRoot: string;
}

/**
 * Parses and validates the environment. Throws a readable error listing every
 * missing or malformed value at once, rather than failing on the first one.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(
      `Invalid server configuration:\n${lines.join('\n')}\n\n` +
        'Copy .env.example to .env at the repository root and fill it in.',
    );
  }

  const env = parsed.data;
  return {
    ...env,
    bootId: BOOT_ID,
    isProduction: env.NODE_ENV === 'production',
    gitDataRoot: resolve(env.GIT_DATA_ROOT),
  };
}

/**
 * The contribution URL for a workspace (section 1.2).
 *
 * Contains the workspace ID and nothing else. It must never carry the owner
 * key: the key travels only in a request header, and a URL is the one thing
 * people paste into chat.
 */
export function contributionUrl(publicAppUrl: string, workspaceId: string): string {
  return `${publicAppUrl.replace(/\/+$/, '')}/w/${workspaceId}`;
}

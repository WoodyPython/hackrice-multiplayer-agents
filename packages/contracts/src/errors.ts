import { z } from 'zod';

/**
 * Design section 12.5: "These map to actionable UI states, not generic failure
 * banners." Every one of these codes has a specific thing the UI should show
 * and a specific thing the user can do next.
 */
export const API_ERROR_CODES = [
  // --- section 12.5, verbatim ---
  'WORKSPACE_NOT_FOUND',
  'OWNER_KEY_REQUIRED',
  'TASK_VERSION_CHANGED',
  'TASK_ALREADY_RUNNING',
  'INPUT_CONFLICT',
  'INVALID_PATH',
  'FILE_VERSION_CHANGED',
  'DOCUMENT_EPOCH_CLOSED',
  'DRAFT_NOT_SAVED',
  'REVIEW_STALE',
  'REVIEW_CONFLICT',
  'AGENT_TIMED_OUT',
  'AGENT_TOKEN_EXHAUSTED',
  'RUN_INTERRUPTED',

  // --- supplementary, needed to keep the above from becoming a catch-all ---
  // Resource lookups. Scoped by workspace: a task in another workspace is
  // NOT_FOUND here, never a permission error, because there is no identity to
  // deny (section 1.2).
  'TASK_NOT_FOUND',
  'MATERIAL_NOT_FOUND',
  'DRAFT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'REVIEW_NOT_FOUND',
  'QUESTION_NOT_FOUND',

  // Request shape failed Zod validation. Carries field details.
  'VALIDATION_FAILED',
  // The operation is legal but not from this state (e.g. cancel on a task with
  // no active run). Carries the current state so the UI can re-render.
  'INVALID_STATE',
  // The question is no longer open: already answered, expired, or canceled.
  'QUESTION_NOT_OPEN',
  // A concurrent writer won. Safe to refetch and retry.
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  WORKSPACE_NOT_FOUND: 404,
  OWNER_KEY_REQUIRED: 403,
  TASK_VERSION_CHANGED: 409,
  TASK_ALREADY_RUNNING: 409,
  INPUT_CONFLICT: 409,
  INVALID_PATH: 400,
  FILE_VERSION_CHANGED: 409,
  DOCUMENT_EPOCH_CLOSED: 409,
  DRAFT_NOT_SAVED: 409,
  REVIEW_STALE: 409,
  REVIEW_CONFLICT: 409,
  AGENT_TIMED_OUT: 410,
  AGENT_TOKEN_EXHAUSTED: 410,
  RUN_INTERRUPTED: 409,

  TASK_NOT_FOUND: 404,
  MATERIAL_NOT_FOUND: 404,
  DRAFT_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  REVIEW_NOT_FOUND: 404,
  QUESTION_NOT_FOUND: 404,

  VALIDATION_FAILED: 400,
  INVALID_STATE: 409,
  QUESTION_NOT_OPEN: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function httpStatusForErrorCode(code: ApiErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

/** The body shape of every non-2xx API response. */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /**
     * Machine-readable context the UI acts on. For TASK_VERSION_CHANGED this
     * carries `currentVersion` so a form can rebase instead of guessing.
     */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatusForErrorCode(code);
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from 'zod';
import { ApiError } from '@app/contracts';

/**
 * Error translation (design section 12.5): "These map to actionable UI states,
 * not generic failure banners."
 *
 * Everything that leaves the API as a non-2xx carries one of the contract's
 * error codes plus, where the UI can act on it, machine-readable details.
 */

/**
 * Parses `value` or throws VALIDATION_FAILED carrying per-field messages.
 *
 * Generic over the SCHEMA, not over its output type. A schema carrying
 * `.default()` or `.refine()` has different input and output types, and binding
 * the parameter as `ZodType<T>` makes inference pick the input one — so every
 * field with a default comes back optional and every call site fails.
 */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown): ZodInfer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(result.error);
}

export function validationError(error: ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    // Keep the first message per field; later ones are usually consequences.
    if (!(path in fields)) fields[path] = issue.message;
  }
  const summary = Object.entries(fields)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');

  return new ApiError('VALIDATION_FAILED', summary || 'Request validation failed', {
    fields,
  });
}

/**
 * Fastify's error handler.
 *
 * Three cases, in order of specificity:
 *  - ApiError: already a contract error, pass it through.
 *  - ZodError that escaped a route: translate it.
 *  - Anything else: log it and return INTERNAL_ERROR with no detail. An
 *    unexpected error's message can contain a connection string or a file path
 *    (section 13.3), so it never reaches the client.
 *
 * Rate limiting is the one Fastify-native error worth reshaping, so a throttled
 * client sees RATE_LIMITED rather than a bare 429 body.
 */
export function registerErrorHandler(app: {
  setErrorHandler(
    handler: (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => void,
  ): unknown;
  setNotFoundHandler(
    handler: (request: FastifyRequest, reply: FastifyReply) => void,
  ): unknown;
}): void {
  app.setErrorHandler((error, request, reply) => {
    if (ApiError.is(error)) {
      void reply.status(error.httpStatus).send(error.toBody());
      return;
    }

    if (error instanceof ZodError) {
      const api = validationError(error);
      void reply.status(api.httpStatus).send(api.toBody());
      return;
    }

    if (error.statusCode === 429) {
      const api = new ApiError('RATE_LIMITED', 'Too many requests. Try again shortly.');
      void reply.status(api.httpStatus).send(api.toBody());
      return;
    }

    // A malformed JSON body is the client's fault, not ours.
    if (error.statusCode === 400 && error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      const api = new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON.');
      void reply.status(api.httpStatus).send(api.toBody());
      return;
    }

    /*
     * An oversized upload. @fastify/multipart and the body parser both abort
     * the stream themselves, so this never reaches the route's own size check.
     *
     * Reported as VALIDATION_FAILED rather than a bare 413 so the client has
     * one branch for every reason a file can be refused — type, emptiness, NUL
     * content, encoding, size — all of which section 3.4 treats alike.
     */
    if (
      error.statusCode === 413 ||
      error.code === 'FST_REQ_FILE_TOO_LARGE' ||
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    ) {
      const api = new ApiError('VALIDATION_FAILED', 'File exceeds the 1 MiB limit.');
      void reply.status(api.httpStatus).send(api.toBody());
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const api = new ApiError('INTERNAL_ERROR', 'Something went wrong.');
    void reply.status(api.httpStatus).send(api.toBody());
  });

  app.setNotFoundHandler((request, reply) => {
    const api = new ApiError(
      'VALIDATION_FAILED',
      `No route for ${request.method} ${request.url}`,
    );
    void reply.status(404).send(api.toBody());
  });
}

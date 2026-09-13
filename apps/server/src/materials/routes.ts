import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  MAX_MATERIAL_FILE_BYTES,
  guestLabelSchema,

  uuidSchema,
} from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import type { PgMaterialService } from './service.js';

/**
 * Material routes (design section 12.1).
 *
 * One upload implementation behind every entry point (section 3.2): the
 * workspace Files view, a task's Materials tab, and a discussion attachment all
 * post here and differ only in the optional taskId and discussionEntryId.
 */

const workspaceParams = z.object({ workspaceId: uuidSchema });
const materialParams = z.object({ workspaceId: uuidSchema, materialId: uuidSchema });
const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });

export interface MaterialRouteDeps {
  materials: PgMaterialService;
}

export async function registerMaterialRoutes(
  app: FastifyInstance,
  deps: MaterialRouteDeps,
): Promise<void> {
  /** Upload. multipart/form-data with one `file` part plus text fields. */
  app.post('/api/workspaces/:workspaceId/materials', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);

    if (!request.isMultipart()) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Upload must be multipart/form-data with a "file" part.',
      );
    }

    const part = await request.file({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES } });
    if (!part) {
      throw new ApiError('VALIDATION_FAILED', 'No file part in the upload.');
    }

    const bytes = await part.toBuffer();
    // @fastify/multipart truncates rather than throwing once the limit is hit,
    // so a silent short file would otherwise be stored as if complete.
    if (part.file.truncated) {
      throw new ApiError('VALIDATION_FAILED', 'File exceeds the 10 MiB limit.', {
        limit: MAX_MATERIAL_FILE_BYTES,
      });
    }

    const fields = parseOrThrow(
      z.object({
        guestLabel: guestLabelSchema,
        taskId: uuidSchema.optional(),
        discussionEntryId: uuidSchema.optional(),
      }),
      readTextFields(part.fields),
    );

    const result = await deps.materials.upload(workspaceId, {
      filename: part.filename,
      bytes,
      contentType: part.mimetype,
      guestLabel: fields.guestLabel,
      taskId: fields.taskId,
      discussionEntryId: fields.discussionEntryId,
    });

    return reply.status(result.created ? 201 : 200).send(result);
  });

  /** Workspace reference list for the Files view. */
  app.get('/api/workspaces/:workspaceId/materials', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    return reply.send({ materials: await deps.materials.listForWorkspace(workspaceId) });
  });

  /**
   * Read or download.
   *
   * Always served as text/plain with nosniff and an attachment disposition,
   * never as the recorded content type. Section 13.3 requires uploaded HTML to
   * render as text; serving it as text/html from this origin would be stored
   * cross-site scripting against every other workspace on the same host.
   */
  app.get('/api/workspaces/:workspaceId/materials/:materialId', async (request, reply) => {
    const { workspaceId, materialId } = parseOrThrow(materialParams, request.params);
    const { material, bytes } = await deps.materials.readSelected(workspaceId, materialId);

    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${sanitizeForHeader(material.filename)}"`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(bytes));
  });

  /** Metadata only, for pickers that do not want the bytes. */
  app.get('/api/workspaces/:workspaceId/materials/:materialId/meta', async (request, reply) => {
    const { workspaceId, materialId } = parseOrThrow(materialParams, request.params);
    const { material } = await deps.materials.readSelected(workspaceId, materialId);
    return reply.send(material);
  });

  /** Attach an existing material to a task or one of its discussion entries. */
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/material-links', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    // The task comes from the path, not the body, so this validates the two
    // remaining fields directly. linkMaterialRequestSchema carries a .refine()
    // and is a ZodEffects, which has no .omit().
    const body = parseOrThrow(
      z.object({
        materialId: uuidSchema,
        discussionEntryId: uuidSchema.optional(),
      }),
      request.body ?? {},
    );
    await deps.materials.link(workspaceId, {
      materialId: body.materialId,
      taskId,
      discussionEntryId: body.discussionEntryId,
    });
    return reply.status(204).send();
  });

  /** Materials attached to a task. Selected by default at Start (section 3.3). */
  app.get('/api/workspaces/:workspaceId/tasks/:taskId/materials', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    return reply.send({ materials: await deps.materials.listForTask(workspaceId, taskId) });
  });
}

/** Multipart text fields arrive as objects; pull out their values. */
function readTextFields(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const field = Array.isArray(value) ? value[0] : value;
    if (
      field &&
      typeof field === 'object' &&
      'value' in field &&
      typeof (field as { value: unknown }).value === 'string'
    ) {
      out[key] = (field as { value: string }).value;
    }
  }
  return out;
}

/**
 * A filename reaches a response header here.
 *
 * validateFilename already rejects separators and control characters, but a
 * quote or a newline surviving into Content-Disposition would let an uploaded
 * name inject a header. Strip anything that is not plainly safe.
 */
function sanitizeForHeader(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

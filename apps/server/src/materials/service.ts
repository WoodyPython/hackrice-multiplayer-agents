import { createHash, randomUUID } from 'node:crypto';
import { ApiError, type Material } from '@app/contracts';
import { isPgError, isUniqueViolation, type Db } from '../db/client.js';
import type { MaterialRow } from '../db/types.js';
import { type BlobStore, materialObjectKey } from './blob-store.js';
import { validateUpload } from './validation.js';
import { toIso } from '../http/serialize.js';

/**
 * B04: reference materials (design section 3.2).
 *
 * "All entry points use the same upload implementation. Reattaching an existing
 * material reuses its ID and bytes." So there is exactly one upload path here,
 * and the three locations in section 3.2's table differ only in which link row
 * they create.
 *
 * Materials are immutable. Nothing in this file updates content: a newer
 * version is a new material with a new ID (section 3.3), which is what lets a
 * running agent keep the version it captured.
 */

export interface MaterialServiceDeps {
  db: Db;
  blobs: BlobStore;
}

export interface UploadInput {
  filename: string;
  bytes: Uint8Array;
  guestLabel: string;
  taskId?: string | undefined;
  discussionEntryId?: string | undefined;
}

export interface UploadResult {
  material: Material;
  /** False when identical bytes were already stored and the row was reused. */
  created: boolean;
}

export class PgMaterialService {
  constructor(private readonly deps: MaterialServiceDeps) {}

  /**
   * Uploads or reuses, then links.
   *
   * Ordering matters and is not obvious. Bytes are written BEFORE the row is
   * inserted, so a reader that sees a material row always finds its object. The
   * cost is that a lost race leaves an unreferenced blob, which we delete; the
   * alternative ordering would leave a readable row pointing at nothing.
   */
  async upload(workspaceId: string, input: UploadInput): Promise<UploadResult> {
    const validated = validateUpload(input.filename, input.bytes);
    const sha256 = createHash('sha256').update(validated.bytes).digest();

    // Section 3.2: reattaching reuses the ID and the bytes. The common case is
    // someone re-uploading a file they already added.
    const existing = await this.findByHash(workspaceId, sha256);
    if (existing) {
      await this.link(workspaceId, {
        materialId: existing.id,
        taskId: input.taskId,
        discussionEntryId: input.discussionEntryId,
      });
      return { material: toMaterial(existing), created: false };
    }

    const materialId = randomUUID();
    const objectKey = materialObjectKey(workspaceId, materialId);
    await this.deps.blobs.put(objectKey, validated.bytes, validated.contentType);

    let row: MaterialRow;
    try {
      row = await this.deps.db
        .insertInto('materials')
        .values({
          id: materialId,
          workspace_id: workspaceId,
          filename: validated.filename,
          object_key: objectKey,
          sha256,
          byte_size: validated.byteSize,
          content_type: validated.contentType,
          guest_label: input.guestLabel,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error, 'materials_content_uq')) {
        // Another request stored the same bytes between our lookup and this
        // insert. Theirs won; drop the object we just wrote so the store does
        // not accumulate unreferenced copies.
        await this.deps.blobs.delete(objectKey).catch(() => undefined);
        const winner = await this.findByHash(workspaceId, sha256);
        if (!winner) throw error;
        await this.link(workspaceId, {
          materialId: winner.id,
          taskId: input.taskId,
          discussionEntryId: input.discussionEntryId,
        });
        return { material: toMaterial(winner), created: false };
      }
      await this.deps.blobs.delete(objectKey).catch(() => undefined);
      throw error;
    }

    await this.link(workspaceId, {
      materialId: row.id,
      taskId: input.taskId,
      discussionEntryId: input.discussionEntryId,
    });

    return { material: toMaterial(row), created: true };
  }

  /**
   * Associates an existing material with a workspace, task, or discussion entry.
   *
   * Idempotent: the `material_links_dedupe_uq` index uses NULLS NOT DISTINCT,
   * so repeating a workspace-level link is a no-op rather than an unbounded
   * pile of rows.
   *
   * Cross-workspace attachment is impossible here because the foreign keys
   * carry workspace_id (section 11.2); this method does not re-check it in
   * application code, it translates the database's refusal.
   */
  async link(
    workspaceId: string,
    input: { materialId: string; taskId?: string | undefined; discussionEntryId?: string | undefined },
  ): Promise<void> {
    if (input.discussionEntryId && !input.taskId) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Linking to a discussion entry requires its task.',
      );
    }

    try {
      await this.deps.db
        .insertInto('material_links')
        .values({
          workspace_id: workspaceId,
          material_id: input.materialId,
          task_id: input.taskId ?? null,
          discussion_entry_id: input.discussionEntryId ?? null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    } catch (error) {
      if (isPgError(error) && error.code === '23503') {
        throw new ApiError(
          'MATERIAL_NOT_FOUND',
          'That material, task, or discussion entry does not belong to this workspace.',
        );
      }
      throw error;
    }
  }

  /**
   * Reads a material's metadata and bytes.
   *
   * Section 11.4: "API retrieval requires the workspace link's ID and a material
   * associated with that workspace; it does not require a login." The workspace
   * scoping in the query IS the access check.
   */
  async readSelected(
    workspaceId: string,
    materialId: string,
  ): Promise<{ material: Material; bytes: Uint8Array }> {
    const row = await this.deps.db
      .selectFrom('materials')
      .selectAll()
      .where('id', '=', materialId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) {
      throw new ApiError('MATERIAL_NOT_FOUND', 'No such material in this workspace.');
    }

    const bytes = await this.deps.blobs.get(row.object_key);
    if (!bytes) {
      // The row promised an object that is not there. Surfacing this rather
      // than returning an empty file matters: a silently empty material would
      // reach a model as legitimate context.
      throw new ApiError(
        'MATERIAL_NOT_FOUND',
        'This material is recorded but its content is unavailable.',
        { materialId },
      );
    }

    return { material: toMaterial(row), bytes };
  }

  /** Workspace-level list for the Files view. Excludes soft-deleted rows. */
  async listForWorkspace(workspaceId: string): Promise<Material[]> {
    const rows = await this.deps.db
      .selectFrom('materials')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toMaterial);
  }

  /**
   * Materials attached directly to a task.
   *
   * Section 3.3: "Direct task attachments are selected by default." These are
   * therefore part of a run's context even without an explicit
   * task_input_links row; C06 unions the two when building the manifest.
   */
  async listForTask(workspaceId: string, taskId: string): Promise<Material[]> {
    const rows = await this.deps.db
      .selectFrom('materials')
      .innerJoin('material_links', 'material_links.material_id', 'materials.id')
      .selectAll('materials')
      .distinctOn('materials.id')
      .where('materials.workspace_id', '=', workspaceId)
      .where('materials.deleted_at', 'is', null)
      .where('material_links.task_id', '=', taskId)
      .execute();
    return rows.map(toMaterial);
  }

  private async findByHash(
    workspaceId: string,
    sha256: Buffer,
  ): Promise<MaterialRow | undefined> {
    return this.deps.db
      .selectFrom('materials')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('sha256', '=', sha256)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }
}

// ---------------------------------------------------------------------------

function toMaterial(row: MaterialRow): Material {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    filename: row.filename,
    // Hex on the wire; bytea at rest. Never the object key: section 11.4 keeps
    // storage layout off the wire.
    sha256: Buffer.from(row.sha256).toString('hex'),
    byteSize: Number(row.byte_size),
    contentType: row.content_type,
    guestLabel: row.guest_label,
    createdAt: toIso(row.created_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
  };
}

import {
  ApiError,
  type UpdateWorkspaceRequest,
  type Workspace,
  type WorkspaceLifecycleHook,
  type WorkspaceService,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Workspace as WorkspaceRow } from '../db/types.js';
import { contributionUrl } from '../config.js';
import { generateOwnerKey, hashOwnerKey, ownerKeyMatches } from './owner-key.js';
import { toIso } from '../http/serialize.js';
import { assertWorkspaceMutable, invalidateTaskReviews } from '../tasks/mutation-guard.js';

/**
 * B02: anonymous workspaces (design sections 1.2, 12.1, 12.2).
 *
 * No accounts, no membership, no invitation redemption, and deliberately no
 * endpoint that lists workspaces (section 1.2). The random workspace ID in the
 * contribution URL is the capability; the owner key is the one privilege check
 * layered on top of it.
 */

export interface WorkspaceServiceDeps {
  db: Db;
  publicAppUrl: string;
  lifecycle: WorkspaceLifecycleHook;
  /** Injected so a hook failure is recorded rather than silently swallowed. */
  onLifecycleError?: (error: unknown, workspaceId: string) => void;
}

export class PgWorkspaceService implements WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /**
   * Create a workspace owned by an account.
   *
   * `ownerUserId` is required in practice -- the route refuses anonymous
   * creation -- and when it is present no owner key is minted at all. The key
   * only ever existed to answer "is this the creator", and a membership row
   * answers it better: it survives a cleared browser, it can be granted to a
   * second person, and it cannot be copied out of a chat log.
   */
  async create(input: { name: string; purpose?: string; ownerUserId?: string }): Promise<{
    workspaceId: string;
    contributionUrl: string;
    ownerKey: string | null;
  }> {
    // Only for the legacy anonymous path. An owned workspace has no key.
    const ownerKey = input.ownerUserId ? null : generateOwnerKey();

    const row = await this.deps.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('workspaces')
        .values({
          name: input.name.trim(),
          purpose: input.purpose?.trim() ?? '',
          owner_key_hash: ownerKey ? hashOwnerKey(ownerKey) : null,
          claimed_at: input.ownerUserId ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (input.ownerUserId) {
        // Same transaction as the workspace: a workspace that exists without
        // its owner is one nobody can administer or invite anyone into.
        await trx.insertInto('workspace_members').values({
          workspace_id: created.id, user_id: input.ownerUserId, role: 'owner',
        }).execute();
      }
      return created;
    });

    // After the insert, never inside it. Section 1.1: repository creation must
    // not be able to fail a workspace creation request, and Role D's Git
    // service ensures the repository on first access anyway, so a failure here
    // is recoverable rather than fatal.
    try {
      this.deps.lifecycle.onWorkspaceCreated({ workspaceId: row.id });
    } catch (error) {
      this.deps.onLifecycleError?.(error, row.id);
    }

    return {
      workspaceId: row.id,
      contributionUrl: contributionUrl(this.deps.publicAppUrl, row.id),
      ownerKey,
    };
  }

  /**
   * `isOwner` is now decided by membership, not by a browser-held key.
   *
   * It remains advisory in exactly the same way: it chooses what the UI draws,
   * and every owner-only operation is re-checked server-side by the
   * authorization hook (section 4.6: "hiding a button is insufficient").
   */
  async resolve(workspaceId: string, isOwner = false): Promise<Workspace | null> {
    const row = await this.findRow(workspaceId);
    if (!row) return null;
    return toPublicWorkspace(row, isOwner);
  }

  /** True while a pre-accounts workspace is still waiting to be claimed. */
  async isUnclaimed(workspaceId: string): Promise<boolean> {
    const row = await this.findRow(workspaceId);
    return row !== undefined && row !== null && row.owner_key_hash !== null;
  }

  async checkOwnerKey(workspaceId: string, ownerKey: string | undefined): Promise<boolean> {
    const row = await this.findRow(workspaceId);
    if (!row) return false;
    return ownerKeyMatches(ownerKey, row.owner_key_hash);
  }

  /**
   * Owner-only (section 1.4).
   *
   * `guidance_version` increments only when the guidance TEXT changes. Section
   * 11.5 re-compares the stored guidance version at Apply, so bumping it for a
   * name edit would invalidate every pending review for no reason.
   *
   * Serialized under the workspace lock, including review invalidation.
   */
  async updateGuidance(
    workspaceId: string,
    input: UpdateWorkspaceRequest,
  ): Promise<Workspace> {
    return this.deps.db.transaction().execute(async (trx) => {
      // No key changes: remain compatible with task writers' FK key-share locks.
      const current = await trx.selectFrom('workspaces').selectAll().where('id', '=', workspaceId)
        .forNoKeyUpdate().executeTakeFirst();
      if (!current) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
      const changed = input.guidance !== undefined && input.guidance !== current.guidance;
      if (changed) await assertWorkspaceMutable(trx, workspaceId);
      const row = await trx.updateTable('workspaces').set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
        guidance_version: current.guidance_version + Number(changed), updated_at: new Date(),
      }).where('id', '=', workspaceId).returningAll().executeTakeFirstOrThrow();
      if (changed) {
        const tasks = await trx.selectFrom('tasks').select('id').where('workspace_id', '=', workspaceId)
          .orderBy('id').forUpdate().execute();
        for (const task of tasks) await invalidateTaskReviews(trx, task.id, `guidance:${row.guidance_version}`);
      }
      return toPublicWorkspace(row, true);
    });
  }

  private async findRow(workspaceId: string): Promise<WorkspaceRow | undefined> {
    return this.deps.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst();
  }
}

/**
 * Row to wire shape.
 *
 * `owner_key_hash` is dropped here by construction rather than by a `delete`,
 * so a future column addition cannot accidentally leak it: every field in the
 * result is written out explicitly.
 */
function toPublicWorkspace(row: WorkspaceRow, isOwner: boolean): Workspace {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    guidance: row.guidance,
    guidanceVersion: row.guidance_version,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    isOwner,
  };
}

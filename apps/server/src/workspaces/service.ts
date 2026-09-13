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
import type { BlobStore } from '../materials/blob-store.js';
import { assertWorkspaceMutable, invalidateTaskReviews } from '../tasks/mutation-guard.js';

/**
 * Workspaces (design sections 1.2, 12.1, 12.2, as amended).
 *
 * B02 built this for anonymous participation: the random workspace ID in the
 * contribution URL was the capability, and an owner key in one browser was the
 * one privilege check on top of it. Accounts replaced that -- ownership is a
 * membership row -- and the lifecycle below is the rest of what a workspace
 * needs once it belongs to somebody: archiving, and a way to be deleted.
 *
 * Still true, and the reason there is no `list` method here: nothing enumerates
 * workspaces. `GET /api/auth/workspaces` returns the caller's own, from their
 * own memberships and visits.
 */

export interface WorkspaceServiceDeps {
  db: Db;
  publicAppUrl: string;
  lifecycle: WorkspaceLifecycleHook;
  /** Injected so a hook failure is recorded rather than silently swallowed. */
  onLifecycleError?: (error: unknown, workspaceId: string) => void;
  /**
   * Material bytes, for deletion only.
   *
   * Rows cascade; the objects they point at do not. Without this, deleting a
   * workspace leaves its uploads in the bucket forever -- the row that said
   * where they were is the only thing that knew, so they become unreachable
   * rather than reclaimed. That is the worst kind of storage growth: invisible
   * and permanent.
   */
  blobs?: Pick<BlobStore, 'delete'>;
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

  /**
   * Archive or restore. Owner only, and reversible by design.
   *
   * Nothing is deleted and nothing is moved: `status` is the flag every other
   * surface already reads. Archiving is the answer to "we are finished with
   * this" that does not require anyone to decide, in that moment, whether they
   * will ever want the work back.
   *
   * Restoring does not resurrect a review that was invalidated while archived;
   * it does not have to, because archiving refuses writes rather than changing
   * them.
   */
  async setStatus(workspaceId: string, status: Workspace['status']): Promise<Workspace> {
    const now = new Date();
    const row = await this.deps.db
      .updateTable('workspaces')
      .set({
        status,
        archived_at: status === 'archived' ? now : null,
        updated_at: now,
      })
      .where('id', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
    return toPublicWorkspace(row, true);
  }

  /**
   * Delete a workspace and everything in it.
   *
   * Two things here are not obvious and both were found the hard way.
   *
   * **The name has to match.** Not authorization -- the gate already proved the
   * caller is an owner -- but the distance between meaning to do this and
   * having clicked the wrong row. Compared after trimming, because a name
   * copied from the heading brings whitespace with it and refusing over that
   * teaches nothing.
   *
   * **One statement, and the cascades do the rest.** `tasks` and `materials`
   * are the only tables referencing `workspaces`; everything else hangs off
   * those. The one foreign key in the schema that is not a cascade --
   * `agent_questions.answer_entry_id`, ON DELETE RESTRICT -- looked like it
   * would refuse this, since the answer it cites is being deleted with
   * everything else. It does not: the cascade removes the question first.
   * Checked directly rather than assumed, and covered by
   * `workspace-lifecycle.test.ts` so a change to that chain fails a test rather
   * than somebody's deletion. The counts are read first, inside the same
   * transaction, so the response describes what was actually removed rather
   * than what was there a moment earlier.
   */
  async destroy(input: { workspaceId: string; confirmName: string }): Promise<{
    workspaceId: string; name: string; deletedTasks: number; deletedMaterials: number;
  }> {
    const summary = await this.deps.db.transaction().execute(async (trx) => {
      const workspace = await trx.selectFrom('workspaces').select(['id', 'name'])
        .where('id', '=', input.workspaceId).forUpdate().executeTakeFirst();
      if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
      if (workspace.name.trim() !== input.confirmName.trim()) {
        throw new ApiError('VALIDATION_FAILED',
          'The name you typed does not match this workspace, so nothing was deleted.');
      }
      const [tasks, objects] = await Promise.all([
        trx.selectFrom('tasks').select(({ fn }) => fn.countAll<string>().as('n'))
          .where('workspace_id', '=', workspace.id).executeTakeFirstOrThrow(),
        // Read the object keys before the rows go: afterwards nothing knows
        // where the bytes are, and an orphaned object is unreachable rather
        // than merely unused.
        trx.selectFrom('materials').select('object_key')
          .where('workspace_id', '=', workspace.id).execute(),
      ]);
      await trx.deleteFrom('workspaces').where('id', '=', workspace.id).execute();
      return {
        workspaceId: workspace.id, name: workspace.name,
        deletedTasks: Number(tasks.n), deletedMaterials: objects.length,
        objectKeys: objects.map((row) => row.object_key),
      };
    });

    // After the commit, never inside it, and never allowed to fail the request.
    // The database is the record of what exists; a repository or an object left
    // behind is disk to reclaim, which is what the garbage collector is for.
    try {
      this.deps.lifecycle.onWorkspaceDeleted({ workspaceId: summary.workspaceId });
    } catch (error) {
      this.deps.onLifecycleError?.(error, summary.workspaceId);
    }
    for (const key of summary.objectKeys) {
      try {
        await this.deps.blobs?.delete(key);
      } catch (error) {
        this.deps.onLifecycleError?.(error, summary.workspaceId);
      }
    }
    const { objectKeys: _discard, ...result } = summary;
    return result;
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

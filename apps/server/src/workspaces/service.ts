import { sql } from 'kysely';
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

  async create(input: { name: string; purpose?: string }): Promise<{
    workspaceId: string;
    contributionUrl: string;
    ownerKey: string;
  }> {
    // Generated here and returned exactly once. Only its hash is stored, and
    // no endpoint can read it back (section 1.2: no recovery flow).
    const ownerKey = generateOwnerKey();

    const row = await this.deps.db
      .insertInto('workspaces')
      .values({
        name: input.name.trim(),
        purpose: input.purpose?.trim() ?? '',
        owner_key_hash: hashOwnerKey(ownerKey),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

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
   * `ownerKey` is optional and advisory: it only decides the `isOwner` flag the
   * UI renders with. Every owner-only operation re-checks the key server-side
   * (section 4.6: "The server performs the same check; hiding a button is
   * insufficient").
   */
  async resolve(workspaceId: string, ownerKey?: string): Promise<Workspace | null> {
    const row = await this.findRow(workspaceId);
    if (!row) return null;
    return toPublicWorkspace(row, ownerKeyMatches(ownerKey, row.owner_key_hash));
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
   * Written as one statement rather than read-then-write so two concurrent
   * owner edits cannot both read the old version and produce a single bump.
   */
  async updateGuidance(
    workspaceId: string,
    input: UpdateWorkspaceRequest,
  ): Promise<Workspace> {
    const name = input.name?.trim() ?? null;
    const purpose = input.purpose ?? null;
    const guidance = input.guidance ?? null;

    const result = await sql<WorkspaceRow>`
      update workspaces set
        name     = coalesce(${name}::text, name),
        purpose  = coalesce(${purpose}::text, purpose),
        guidance = coalesce(${guidance}::text, guidance),
        guidance_version = guidance_version + case
          when ${guidance}::text is not null
           and ${guidance}::text is distinct from guidance
          then 1 else 0 end,
        updated_at = now()
      where id = ${workspaceId}::uuid
      returning *
    `.execute(this.deps.db);

    const row = result.rows[0];
    if (!row) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');

    // The caller already proved ownership to reach this method.
    return toPublicWorkspace(row, true);
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

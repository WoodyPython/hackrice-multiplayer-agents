import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { supabaseHeaders } from '../supabase-auth.js';

/**
 * Object storage for material bytes.
 *
 * Design section 5 names Supabase Storage as the store. This interface exists
 * for the same reason section 9.1 requires one for the model adapter — "keep a
 * test adapter behind the same interface" — and it has a practical payoff here:
 * everything else in B04 (validation, hashing, dedupe, links, scoping) is
 * storage-agnostic, so the whole ticket can be built and tested before a
 * Supabase project exists.
 *
 * Keys are opaque to callers and are generated from workspace and material IDs,
 * never from an uploaded filename (section 11.4).
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/**
 * A stored object key.
 *
 * `${workspaceId}/${materialId}` — both server-generated UUIDs, so the key is
 * unique by construction and contains nothing a user supplied. Content
 * addressing by hash would be tempting for deduplication, but `object_key` is
 * UNIQUE and a soft-deleted material can legitimately be re-uploaded, which
 * would collide. Deduplication is handled by the sha256 index instead.
 */
export function materialObjectKey(workspaceId: string, materialId: string): string {
  return `${workspaceId}/${materialId}`;
}

/** Rejects anything that is not exactly two UUID-shaped segments. */
const KEY_PATTERN =
  /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`refusing to use unsafe object key: ${JSON.stringify(key)}`);
  }
}

// ---------------------------------------------------------------------------

/**
 * Local filesystem store for development and tests.
 *
 * Not a production target: it lives on the same disk section 5.3 reserves for
 * Git, and it has no replication. It exists so B04 is complete and verified
 * before Supabase is configured.
 */
export class LocalDiskBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    // Belt and braces: even with the key pattern above, never write outside root.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('object key escaped the store root');
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

// ---------------------------------------------------------------------------

/**
 * Whether a failed storage response means "there is no such object".
 *
 * Supabase Storage does not answer a missing object with HTTP 404. It answers
 * **400**, and puts the status it means in the body:
 *
 *     {"statusCode":"404","error":"not_found","message":"Object not found",
 *      "code":"NoSuchKey"}
 *
 * So the status line cannot distinguish "not there" from "malformed request",
 * and the body is the only thing that can. Newer storage-api versions do return
 * a real 404, so both are accepted and neither is relied upon.
 *
 * A missing *bucket* is also 400, and also carries `"statusCode":"404"` — so the
 * discriminator has to be `code`, not the status the body claims. It must keep
 * throwing: a mistyped `SUPABASE_STORAGE_BUCKET` would otherwise read as "every
 * material is missing", turning a configuration error into a silent empty
 * store. Same for a wrong key, which arrives as 400 `AccessDenied`.
 *
 * Only the machine-readable code is read, never echoed into the error: the body
 * can quote the request, and the service-role key is in the headers (13.3).
 * Reading it consumes it, which is deliberate — a later attempt to put the body
 * into an error message fails loudly rather than leaking it quietly.
 */
async function isMissingObject(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown };
    if (body.code === 'NoSuchBucket') return false;
    return body.code === 'NoSuchKey' || body.error === 'not_found';
  } catch {
    // Not JSON, so not a shape we can classify. Let the caller throw.
    return false;
  }
}

/**
 * Supabase Storage over its REST API.
 *
 * Deliberately plain fetch rather than supabase-js: the three operations here
 * are single HTTP calls, and the service-role key must stay on the server
 * (section 11.4), so the client library's session handling buys nothing.
 *
 * Verified against a live project by `npm run supabase:smoke`: upload, read
 * back, delete, and read-after-delete. Everything above the interface is covered
 * by tests using LocalDiskBlobStore, and `isMissingObject` below is covered by
 * tests against recorded response shapes.
 */
export class SupabaseBlobStore implements BlobStore {
  constructor(
    private readonly config: {
      url: string;
      serviceRoleKey: string;
      bucket: string;
    },
  ) {}

  private endpoint(key: string): string {
    assertSafeKey(key);
    return `${this.config.url.replace(/\/+$/, '')}/storage/v1/object/${this.config.bucket}/${key}`;
  }

  private headers(): Record<string, string> {
    return supabaseHeaders(this.config.serviceRoleKey);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await fetch(this.endpoint(key), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': contentType,
        // Materials are immutable (section 3.2), but a retried upload of the
        // same material must not fail.
        'x-upsert': 'true',
      },
      // Blob rather than the raw view: BodyInit's ArrayBufferView member is not
      // in scope without lib.dom, and Blob is a Node global from 18 onward.
      body: new Blob([bytes], { type: contentType }),
    });
    if (!response.ok) {
      // Never include the response body: it can echo the request, and the
      // service-role key is in the headers (section 13.3).
      throw new Error(`storage upload failed with ${response.status}`);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await fetch(this.endpoint(key), { headers: this.headers() });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (await isMissingObject(response)) return null;
    throw new Error(`storage read failed with ${response.status}`);
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(this.endpoint(key), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (response.ok) return;
    // Deleting something that is already gone is the outcome the caller wanted.
    // This matters more than it looks: the upload path deletes the object to
    // roll back a lost dedupe race, and that must not turn into a second error.
    if (await isMissingObject(response)) return;
    throw new Error(`storage delete failed with ${response.status}`);
  }
}

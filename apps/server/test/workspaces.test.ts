import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_KEY_HEADER } from '@app/contracts';
import { hashOwnerKey, ownerKeyMatches } from '../src/workspaces/owner-key.js';
import { contributionUrl } from '../src/config.js';
import { TEST_APP_URL, buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B02 acceptance (design sections 1.2, 1.4, 11.5, 12.1, 12.2, 13.3).
 *
 * The behaviours under test are the ones that would be invisible if broken:
 * that the owner key is genuinely the only privilege boundary, that it never
 * leaks, and that guidance_version moves exactly when section 11.5 needs it to.
 */

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('POST /api/workspaces', () => {
  it('returns the id, a contribution URL, and the owner key once', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'Launch prep', purpose: 'Ship the FAQ' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.contributionUrl).toBe(contributionUrl(TEST_APP_URL, body.workspaceId));
    expect(typeof body.ownerKey).toBe('string');
  });

  it('mints a 256-bit key with no URL-unsafe characters', async () => {
    const { ownerKey } = await createWorkspaceViaApi(t.app);
    // 32 random bytes, base64url encoded.
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(ownerKey, 'base64url')).toHaveLength(32);
  });

  it('never puts the owner key in the contribution URL', async () => {
    // Section 1.2: the key "never appears in the shared URL". The URL is the
    // one thing people paste into group chat.
    const { contributionUrl: url, ownerKey, workspaceId } = await createWorkspaceViaApi(t.app);
    expect(url).toContain(workspaceId);
    expect(url).not.toContain(ownerKey);
  });

  it('gives every workspace a different key', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      keys.add((await createWorkspaceViaApi(t.app)).ownerKey);
    }
    expect(keys.size).toBe(5);
  });

  it('stores only the hash, never the key itself', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    const row = await t.handle.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();

    expect(row.owner_key_hash).toEqual(hashOwnerKey(ownerKey));
    // Belt and braces: the raw key appears nowhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(ownerKey);
  });

  it('signals the Git service exactly once per workspace', async () => {
    const before = t.lifecycle.created.length;
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    expect(t.lifecycle.created.slice(before)).toEqual([workspaceId]);
  });

  it('rejects a blank name', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.details.fields).toHaveProperty('name');
  });

  it('rejects a malformed JSON body with a contract error, not a Fastify one', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('a workspace creation failure cannot be caused by the Git service', () => {
  it('still creates the workspace when the lifecycle hook throws', async () => {
    // Section 1.1: repository creation must not be able to fail a workspace
    // creation request. Role D's ensure-on-first-access path repairs it.
    const throwing = await buildTestApp();
    const original = throwing.lifecycle.onWorkspaceCreated.bind(throwing.lifecycle);
    throwing.lifecycle.onWorkspaceCreated = () => {
      throw new Error('git data root unavailable');
    };

    try {
      const res = await throwing.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: 'Resilient' },
      });
      expect(res.statusCode).toBe(201);

      const row = await throwing.handle.db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', res.json().workspaceId)
        .executeTakeFirst();
      expect(row).toBeTruthy();
    } finally {
      throwing.lifecycle.onWorkspaceCreated = original;
      await throwing.close();
    }
  });
});

describe('GET /api/workspaces/:workspaceId', () => {
  it('is readable by anyone holding the link', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app, {
      name: 'Open house',
      purpose: 'Anyone can read this',
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: workspaceId,
      name: 'Open house',
      purpose: 'Anyone can read this',
      guidanceVersion: 1,
      status: 'active',
      isOwner: false,
    });
  });

  it('never returns the owner key hash', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(res.body).not.toContain('owner_key_hash');
    expect(res.json()).not.toHaveProperty('ownerKeyHash');
  });

  it('reports isOwner only for the correct key', async () => {
    const a = await createWorkspaceViaApi(t.app, { name: 'A' });
    const b = await createWorkspaceViaApi(t.app, { name: 'B' });

    const withOwn = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${a.workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: a.ownerKey },
    });
    expect(withOwn.json().isOwner).toBe(true);

    // Another workspace's key is just a wrong key here.
    const withOther = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${a.workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: b.ownerKey },
    });
    expect(withOther.json().isOwner).toBe(false);
  });

  it('returns timestamps as real dates, not raw column values', async () => {
    // Regression: Generated<Timestamp> nested two ColumnTypes and Selectable
    // could not unwrap it, so created_at typed as the column rather than Date.
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const row = await t.handle.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    expect(row.created_at).toBeInstanceOf(Date);

    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(Date.parse(res.json().createdAt)).not.toBeNaN();
  });

  it('404s an unknown workspace', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('rejects a non-UUID id instead of letting it reach a path', async () => {
    /*
     * Section 12.1: "A caller cannot pass an arbitrary room name that opens a
     * filesystem path." Workspace IDs reach /data/repos/<id>.git and Yjs room
     * names, so the invariant is that nothing but a real UUID gets through.
     *
     * Two rejection paths are both correct and the router picks between them:
     * an id that reaches the handler fails Zod validation (400), while one
     * containing encoded separators does not match the route at all (404).
     * What must never happen is a 2xx or a 5xx.
     */
    const traversals = [
      '../../etc/passwd',
      'not-a-uuid',
      '..',
      '%2e%2e',
      '00000000-0000-0000-0000-00000000000',
      'null',
      '../../../data/repos',
    ];

    for (const bad of traversals) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/workspaces/${encodeURIComponent(bad)}`,
      });
      expect([400, 404], `id ${bad} was not rejected`).toContain(res.statusCode);
      // Always a contract error body, never a stack trace or a raw framework error.
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('PATCH /api/workspaces/:workspaceId', () => {
  it('refuses without a key', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      payload: { guidance: 'Prefer short sentences.' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OWNER_KEY_REQUIRED');
  });

  it('refuses a wrong key with the same response as no key', async () => {
    const a = await createWorkspaceViaApi(t.app, { name: 'A' });
    const b = await createWorkspaceViaApi(t.app, { name: 'B' });

    const missing = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${a.workspaceId}`,
      payload: { guidance: 'x' },
    });
    const wrong = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${a.workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: b.ownerKey },
      payload: { guidance: 'x' },
    });

    expect(wrong.statusCode).toBe(missing.statusCode);
    expect(wrong.json()).toEqual(missing.json());
  });

  it('never accepts a claimed-owner flag in the body', async () => {
    // Section 12.2: "Do not accept an isOwner flag, guest label, or claimed
    // creator ID instead."
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      payload: { guidance: 'x', isOwner: true, creatorId: 'me' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OWNER_KEY_REQUIRED');
  });

  it('applies the update for the real owner', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: ownerKey },
      payload: { name: 'Renamed', guidance: 'Prefer short sentences.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Renamed',
      guidance: 'Prefer short sentences.',
      guidanceVersion: 2,
      isOwner: true,
    });
  });

  it('404s an unknown workspace even with a well-formed key', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${randomUUID()}`,
      headers: { [OWNER_KEY_HEADER]: 'a'.repeat(43) },
      payload: { guidance: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('rejects an empty update', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: ownerKey },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('guidance_version', () => {
  /**
   * Section 11.5 re-compares the stored guidance version at Apply, so every
   * spurious bump invalidates pending reviews for no reason, and every missed
   * bump lets a review apply against guidance that changed under it.
   */
  async function patch(
    workspaceId: string,
    ownerKey: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: ownerKey },
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json().guidanceVersion;
  }

  it('bumps when the guidance text changes', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    expect(await patch(workspaceId, ownerKey, { guidance: 'First' })).toBe(2);
    expect(await patch(workspaceId, ownerKey, { guidance: 'Second' })).toBe(3);
  });

  it('does not bump when only the name or purpose changes', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    await patch(workspaceId, ownerKey, { guidance: 'Stable guidance' });
    expect(await patch(workspaceId, ownerKey, { name: 'New name' })).toBe(2);
    expect(await patch(workspaceId, ownerKey, { purpose: 'New purpose' })).toBe(2);
  });

  it('does not bump when the guidance is resubmitted unchanged', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    await patch(workspaceId, ownerKey, { guidance: 'Same text' });
    expect(await patch(workspaceId, ownerKey, { guidance: 'Same text' })).toBe(2);
  });

  it('bumps once per distinct change under concurrent owner edits', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    // A read-then-write implementation would let both reads see version 1 and
    // produce a single bump. One statement cannot.
    const results = await Promise.all([
      patch(workspaceId, ownerKey, { guidance: 'Edit A' }),
      patch(workspaceId, ownerKey, { guidance: 'Edit B' }),
    ]);
    expect(results.sort()).toEqual([2, 3]);
  });
});

describe('owner key primitives', () => {
  it('rejects an absent, empty, or malformed candidate', async () => {
    const hash = hashOwnerKey('correct-horse-battery-staple');
    expect(ownerKeyMatches(undefined, hash)).toBe(false);
    expect(ownerKeyMatches(null, hash)).toBe(false);
    expect(ownerKeyMatches('', hash)).toBe(false);
    expect(ownerKeyMatches('wrong', hash)).toBe(false);
    expect(ownerKeyMatches('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects a stored hash of the wrong length rather than throwing', async () => {
    // timingSafeEqual throws on a length mismatch; a corrupt row must not 500.
    expect(ownerKeyMatches('anything', Buffer.alloc(16))).toBe(false);
  });

  it('ignores a repeated header instead of picking one', async () => {
    const { workspaceId, ownerKey } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}`,
      headers: { [OWNER_KEY_HEADER]: [ownerKey, 'another'] },
    });
    expect(res.json().isOwner).toBe(false);
  });
});

describe('the owner key never reaches the logs', () => {
  it('redacts the header even at debug level', async () => {
    // Section 13.3. Fastify logs request headers, so without redaction the key
    // would sit in plaintext in every owner request's log line.
    const logged = await buildTestApp({ captureLogs: true });
    try {
      const { workspaceId, ownerKey } = await createWorkspaceViaApi(logged.app);
      await logged.app.inject({
        method: 'PATCH',
        url: `/api/workspaces/${workspaceId}`,
        headers: { [OWNER_KEY_HEADER]: ownerKey },
        payload: { guidance: 'Logged run' },
      });

      const text = logged.logs?.text() ?? '';
      expect(text.length).toBeGreaterThan(0);
      // The request WAS logged, and the key is nowhere in that output.
      expect(text).toContain('/api/workspaces/');
      expect(text).not.toContain(ownerKey);

      /*
       * That alone would pass with no redaction at all, because Fastify's req
       * serializer drops headers before pino sees them. So drive the key
       * through the shapes someone could plausibly log it in, and require each
       * to come back censored.
       */
      logged.app.log.info({ headers: { [OWNER_KEY_HEADER]: ownerKey } }, 'bare headers');
      logged.app.log.info({ ownerKey }, 'by name');
      logged.app.log.info({ body: { ownerKey } }, 'nested by name');
      logged.app.log.info(
        { ctx: { headers: { [OWNER_KEY_HEADER]: ownerKey } } },
        'nested headers',
      );

      const after = logged.logs?.text() ?? '';
      expect(after).not.toContain(ownerKey);
      // Four log lines, four censored values.
      expect(after.split('[redacted]').length - 1).toBe(4);
    } finally {
      await logged.close();
    }
  });
});

describe('there is no endpoint that lists workspaces', () => {
  it('does not expose a collection route', async () => {
    // Section 1.2: "Do not list workspaces publicly or expose an endpoint
    // returning everyone's workspaces."
    await createWorkspaceViaApi(t.app, { name: 'Should stay private' });
    const res = await t.app.inject({ method: 'GET', url: '/api/workspaces' });
    expect(res.statusCode).toBe(404);
  });
});

describe('workspace creation rate limit', () => {
  it('refuses past the configured ceiling', async () => {
    const limited = await buildTestApp({
      config: { WORKSPACE_CREATE_MAX: 3, WORKSPACE_CREATE_WINDOW: '1 minute' },
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const ok = await limited.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          payload: { name: `Workspace ${i}` },
        });
        expect(ok.statusCode).toBe(201);
      }

      const blocked = await limited.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: 'One too many' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });

  it('does not limit reading a workspace', async () => {
    const limited = await buildTestApp({
      config: { WORKSPACE_CREATE_MAX: 1, WORKSPACE_CREATE_WINDOW: '1 minute' },
    });
    try {
      const { workspaceId } = await createWorkspaceViaApi(limited.app);
      for (let i = 0; i < 10; i += 1) {
        const res = await limited.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}`,
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});

describe('CORS', () => {
  it('allows the owner key header through preflight', async () => {
    // Without this the browser blocks every owner operation with an opaque
    // CORS error, because x-owner-key is a non-simple header.
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: `/api/workspaces/${randomUUID()}`,
      headers: {
        origin: TEST_APP_URL,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': OWNER_KEY_HEADER,
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      OWNER_KEY_HEADER,
    );
  });
});

describe('health', () => {
  it('reports the boot id runs and agents will reference', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().bootId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

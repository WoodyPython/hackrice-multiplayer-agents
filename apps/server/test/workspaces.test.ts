import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_KEY_HEADER } from '@app/contracts';
import { hashOwnerKey, ownerKeyMatches } from '../src/workspaces/owner-key.js';
import { contributionUrl } from '../src/config.js';
import { TEST_APP_URL, buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';
import { signInAs } from './helpers.js';

/**
 * B02 acceptance, updated for accounts.
 *
 * The privilege boundary is now a membership row, not a browser-held owner key,
 * so the tests that asserted the key WAS the boundary now assert that it is
 * not. What did not change: nothing may leak a secret, and guidance_version
 * still moves exactly when section 11.5 needs it to.
 *
 * Cross-workspace isolation and the role matrix live in `permissions.test.ts`,
 * which builds its own unauthenticated callers rather than inheriting this
 * suite's signed-in fixture owner.
 */

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('POST /api/workspaces', () => {
  it('makes the creating account the owner and mints no key at all', async () => {
    const before = t.lifecycle.created.length;
    const res = await t.app.inject({ method: 'POST', url: '/api/workspaces',
      payload: { name: 'Launch prep', purpose: 'Ship the FAQ' } });
    expect(res.statusCode).toBe(201);
    const { workspaceId, contributionUrl: url, ownerKey } = res.json();
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(url).toBe(contributionUrl(TEST_APP_URL, workspaceId));
    expect(url).toContain(workspaceId);
    // No key exists to leak, be copied out of a chat, or be lost with a
    // cleared browser. Ownership is the membership row instead.
    expect(ownerKey).toBeNull();
    const row = await t.handle.db.selectFrom('workspaces').selectAll()
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    expect(row.owner_key_hash).toBeNull();
    expect(row.claimed_at).not.toBeNull();
    const members = await t.handle.db.selectFrom('workspace_members').selectAll()
      .where('workspace_id', '=', workspaceId).execute();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ user_id: t.ownerUserId, role: 'owner' });
    expect(t.lifecycle.created.slice(before)).toEqual([workspaceId]);
  });

  it('refuses to create a workspace for a caller who is not signed in', async () => {
    // Otherwise the workspace would exist with no owner and no way to invite
    // anyone -- unmanageable from the moment it is created.
    const res = await t.app.inject({ method: 'POST', url: '/api/workspaces',
      payload: { name: 'Nobody home' }, headers: { cookie: '' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
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
  it('is readable by anyone holding the link, as a viewer', async () => {
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
      // The fixture caller owns it; a link holder's view is covered in
      // permissions.test.ts, which can actually be somebody else.
      isOwner: true,
      access: 'owner',
    });
  });

  it('never returns the owner key hash', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(res.body).not.toContain('owner_key_hash');
    expect(res.json()).not.toHaveProperty('ownerKeyHash');
  });

  it('reports isOwner from membership, and ignores the old header entirely', async () => {
    const a = await createWorkspaceViaApi(t.app, { name: 'A' });
    const owner = await t.app.inject({ method: 'GET', url: `/api/workspaces/${a.workspaceId}` });
    expect(owner.json()).toMatchObject({ isOwner: true, access: 'owner' });

    const member = await signInAs(t.handle.db, { workspaceId: a.workspaceId, role: 'member' });
    const asMember = await t.app.inject({ method: 'GET',
      url: `/api/workspaces/${a.workspaceId}`, headers: { cookie: member.cookie } });
    expect(asMember.json()).toMatchObject({ isOwner: false, access: 'member' });

    // The owner-key header is dead as an authority. Sending a well-formed one
    // as a non-member must not promote anybody.
    const outsider = await signInAs(t.handle.db);
    const spoofed = await t.app.inject({ method: 'GET', url: `/api/workspaces/${a.workspaceId}`,
      headers: { cookie: outsider.cookie, [OWNER_KEY_HEADER]: 'a'.repeat(43) } });
    expect(spoofed.json()).toMatchObject({ isOwner: false, access: 'viewer' });
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
  it('tells a signed-out caller to sign in, and a non-owner that it is not theirs', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const anonymous = await t.app.inject({ method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`, headers: { cookie: '' },
      payload: { guidance: 'Prefer short sentences.' } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('AUTH_REQUIRED');

    // A member is signed in and belongs here, but settings are the owner's.
    // The two cases get different codes on purpose: "sign in" and "this is not
    // yours" need different things from the reader.
    const member = await signInAs(t.handle.db, { workspaceId, role: 'member' });
    const denied = await t.app.inject({ method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`, headers: { cookie: member.cookie },
      payload: { guidance: 'x' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
  });

  it('answers a non-member identically whichever workspace they belong to', async () => {
    const a = await createWorkspaceViaApi(t.app, { name: 'A' });
    const b = await createWorkspaceViaApi(t.app, { name: 'B' });

    // Belonging to some other workspace must look exactly like belonging to
    // none, or the response becomes a way to enumerate memberships.
    const elsewhere = await signInAs(t.handle.db, { workspaceId: b.workspaceId, role: 'owner' });
    const stranger = await signInAs(t.handle.db);
    const first = await t.app.inject({ method: 'PATCH', url: `/api/workspaces/${a.workspaceId}`,
      headers: { cookie: elsewhere.cookie }, payload: { guidance: 'x' } });
    const second = await t.app.inject({ method: 'PATCH', url: `/api/workspaces/${a.workspaceId}`,
      headers: { cookie: stranger.cookie }, payload: { guidance: 'x' } });

    expect(first.statusCode).toBe(second.statusCode);
    expect(first.json()).toEqual(second.json());
  });

  it('never accepts a claimed role in the body or an owner key in a header', async () => {
    // Section 12.2: "Do not accept an isOwner flag, guest label, or claimed
    // creator ID instead." Still exactly right; only the real proof changed.
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const outsider = await signInAs(t.handle.db);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: { cookie: outsider.cookie, [OWNER_KEY_HEADER]: 'a'.repeat(43) },
      payload: { guidance: 'x', isOwner: true, role: 'owner', creatorId: 'me' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('applies the update for the real owner', async () => {
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
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

  it('refuses an unknown workspace before saying whether it exists', async () => {
    // Inverted deliberately. Authorization now runs before the handler, so a
    // caller with no membership is refused rather than told which random UUIDs
    // happen to be real workspaces. Nobody can administer a workspace they are
    // not in, so a 404 here would have unlocked nothing.
    const res = await t.app.inject({
      method: 'PATCH', url: `/api/workspaces/${randomUUID()}`, payload: { guidance: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
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

  it('grants nothing for any owner-key header, repeated or not', async () => {
    // The header used to be the whole permission system. No route reads it now,
    // and this is what says so: a non-member sending one -- once or twice --
    // stays a viewer.
    const { workspaceId } = await createWorkspaceViaApi(t.app);
    const outsider = await signInAs(t.handle.db);
    for (const value of ['a'.repeat(43), ['a'.repeat(43), 'another']]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}`,
        headers: { cookie: outsider.cookie, [OWNER_KEY_HEADER]: value } });
      expect(res.json().access).toBe('viewer');
    }
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

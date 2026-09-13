import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@app/contracts';
import { buildTestApp, type TestApp } from './app-helpers.js';
import { signInAs } from './helpers.js';

/**
 * Who may do what, and to which workspace.
 *
 * This suite deliberately builds its app with `authenticate: false`. Every other
 * server suite is handed the fixture owner's cookie so it can test its own
 * subject; a suite about authorization must never be handed an identity it did
 * not ask for, or it would be testing the harness instead of the gate.
 *
 * The three properties under test:
 *
 * 1. **Cross-workspace isolation.** Belonging to one workspace grants nothing
 *    anywhere else, and is indistinguishable from belonging to none.
 * 2. **Default-deny on writes.** Every mutating route refuses a link holder.
 *    The policy function is tested directly too, so a route added later is
 *    covered before anyone remembers to add it to a list.
 * 3. **Only a real secret creates authority.** Not a URL, not a header, not a
 *    field in a request body.
 */

let t: TestApp;
/** Workspace A, owned by `ownerA`. */
let workspaceA: string;
let ownerA: { cookie: string; userId: string };
let memberA: { cookie: string; userId: string };
/** A different workspace, to prove memberships do not travel. */
let workspaceB: string;
let ownerB: { cookie: string; userId: string };
/** Signed in, belongs to nothing. */
let stranger: { cookie: string; userId: string };

const anonymous = { cookie: '' };

beforeAll(async () => {
  t = await buildTestApp({ authenticate: false });
  ownerA = await signInAs(t.handle.db, { label: 'owner-a' });
  ownerB = await signInAs(t.handle.db, { label: 'owner-b' });
  memberA = await signInAs(t.handle.db, { label: 'member-a' });
  stranger = await signInAs(t.handle.db, { label: 'stranger' });

  workspaceA = (await create(ownerA.cookie, 'Workspace A')).workspaceId;
  workspaceB = (await create(ownerB.cookie, 'Workspace B')).workspaceId;
  await t.handle.db.insertInto('workspace_members')
    .values({ workspace_id: workspaceA, user_id: memberA.userId, role: 'member' }).execute();
});

afterAll(async () => { await t?.close(); });

async function create(cookie: string, name: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/workspaces',
    headers: { cookie }, payload: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { workspaceId: string };
}

const call = (method: string, url: string, cookie: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, headers: { cookie },
    ...(payload === undefined ? {} : { payload }) });

describe('cross-workspace isolation', () => {
  it('does not let an owner of one workspace touch another', async () => {
    // The single most important property here: authority is per workspace, and
    // being an owner somewhere is not being an owner everywhere.
    const read = await call('GET', `/api/workspaces/${workspaceA}`, ownerB.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ access: 'viewer', isOwner: false });

    const write = await call('POST', `/api/workspaces/${workspaceA}/tasks`, ownerB.cookie,
      { title: 'Not mine', kind: 'agent_task' });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('FORBIDDEN');

    const administer = await call('PATCH', `/api/workspaces/${workspaceA}`, ownerB.cookie,
      { guidance: 'mine now' });
    expect(administer.statusCode).toBe(403);
  });

  it('answers a foreign owner exactly as it answers a total stranger', async () => {
    // If these differed, the response would leak which workspaces an account
    // belongs to.
    const foreign = await call('POST', `/api/workspaces/${workspaceA}/tasks`, ownerB.cookie,
      { title: 'x', kind: 'agent_task' });
    const nobody = await call('POST', `/api/workspaces/${workspaceA}/tasks`, stranger.cookie,
      { title: 'x', kind: 'agent_task' });
    expect(foreign.statusCode).toBe(nobody.statusCode);
    expect(foreign.json()).toEqual(nobody.json());
  });

  it('lists only the workspaces an account actually belongs to', async () => {
    const res = await call('GET', '/api/auth/session', ownerA.cookie);
    const ids = res.json().workspaces.map((w: { workspaceId: string }) => w.workspaceId);
    expect(ids).toContain(workspaceA);
    expect(ids).not.toContain(workspaceB);
  });
});

describe('writes are denied by default', () => {
  /**
   * Every mutating route under a workspace. A viewer must be refused by all of
   * them; presence is the one deliberate exception, and it is asserted as such
   * below rather than quietly omitted here.
   */
  const MUTATIONS: Array<[string, string, unknown?]> = [
    ['POST', '/tasks', { title: 'x', kind: 'agent_task', creatorGuestLabel: 'Guest Cedar' }],
    ['PATCH', '/tasks/:taskId', { expectedVersion: 1, title: 'x' }],
    ['POST', '/tasks/:taskId/start', { expectedVersion: 1, clientRequestId: randomUUID() }],
    ['POST', '/tasks/:taskId/cancel', { clientRequestId: randomUUID() }],
    ['POST', '/tasks/:taskId/retry', { expectedVersion: 1, clientRequestId: randomUUID(), savedOutputs: [] }],
    ['POST', '/tasks/:taskId/discussion', { body: 'hello' }],
    ['POST', '/tasks/:taskId/answer', { questionId: randomUUID(), body: 'x' }],
    ['POST', '/tasks/:taskId/material-links', { materialId: randomUUID() }],
    ['POST', '/tasks/:taskId/drafts', { path: 'documents/a.md' }],
    ['PATCH', '/tasks/:taskId/status', { expectedStatus: 'posted', status: 'completed' }],
    ['POST', '/drafts/open', { path: 'documents/a.md' }],
    ['PATCH', '', { guidance: 'x' }],
    ['POST', '/invitations', {}],
    ['DELETE', '/invitations/:invitationId'],
    ['PATCH', '/members/:userId', { role: 'owner' }],
    ['DELETE', '/members/:userId'],
  ];

  it.each(MUTATIONS)('refuses a link holder: %s %s', async (method, suffix, payload) => {
    const url = `/api/workspaces/${workspaceA}${suffix}`
      .replace(':taskId', randomUUID()).replace(':reviewId', randomUUID())
      .replace(':invitationId', randomUUID()).replace(':userId', randomUUID());
    const res = await call(method, url, stranger.cookie, payload);
    // 403 for a signed-in non-member. Never a 2xx, and never a 500 -- a crash
    // inside the gate would be a failure to authorize, not a refusal.
    expect(res.statusCode, `${method} ${suffix} -> ${res.body}`).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it.each(MUTATIONS)('tells a signed-out caller to sign in: %s %s', async (method, suffix, payload) => {
    const url = `/api/workspaces/${workspaceA}${suffix}`
      .replace(':taskId', randomUUID()).replace(':reviewId', randomUUID())
      .replace(':invitationId', randomUUID()).replace(':userId', randomUUID());
    const res = await call(method, url, anonymous.cookie, payload);
    expect(res.statusCode, `${method} ${suffix} -> ${res.body}`).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('covers a route registered after the gate was installed', async () => {
    /*
     * The reason this gate is a hook rather than a check inside each handler.
     *
     * Several routers -- reviews and collaboration checkpoints among them --
     * register onto the same instance later, from the runtime rather than the
     * app factory. If the hook only covered what existed when it was added,
     * those would be wide open and nothing here would notice. So this registers
     * a brand-new mutating route after the fact and asserts it is refused
     * without anybody having classified it.
     */
    const late = await buildTestApp({
      authenticate: false,
      extraRoutes: (app) => {
        app.post('/api/workspaces/:workspaceId/late-arrival', async () => ({ ok: true }));
      },
    });
    try {
      const outsider = await signInAs(late.handle.db, { label: 'late-outsider' });
      const res = await late.app.inject({ method: 'POST',
        url: `/api/workspaces/${randomUUID()}/late-arrival`,
        headers: { cookie: outsider.cookie }, payload: {} });
      expect(res.statusCode, res.body).toBe(403);
    } finally {
      await late.close();
    }
  });

  it('still lets a link holder read, and say they are present', async () => {
    // The viewer tier is the whole point of read-only links; if this broke,
    // sharing progress with someone outside the team would stop working.
    expect((await call('GET', `/api/workspaces/${workspaceA}/tasks`, stranger.cookie)).statusCode).toBe(200);
    expect((await call('GET', `/api/workspaces/${workspaceA}/materials`, stranger.cookie)).statusCode).toBe(200);
    const presence = await call('POST', `/api/workspaces/${workspaceA}/presence`, stranger.cookie,
      { presenceId: randomUUID(), name: 'Guest Cedar', color: '#2c4270' });
    expect(presence.statusCode, presence.body).toBe(200);
  });

  it('keeps the member list away from link holders', async () => {
    // Names of colleagues are not part of "read the work".
    expect((await call('GET', `/api/workspaces/${workspaceA}/members`, stranger.cookie)).statusCode).toBe(403);
    expect((await call('GET', `/api/workspaces/${workspaceA}/members`, memberA.cookie)).statusCode).toBe(200);
  });

  it('shows email addresses to owners only', async () => {
    const asOwner = await call('GET', `/api/workspaces/${workspaceA}/members`, ownerA.cookie);
    const asMember = await call('GET', `/api/workspaces/${workspaceA}/members`, memberA.cookie);
    expect(asOwner.json().members.some((m: { email: string }) => m.email.includes('@'))).toBe(true);
    expect(asMember.json().members.every((m: { email: string }) => m.email === '')).toBe(true);
  });
});

describe('roles', () => {
  it('lets a member do the work but not administer', async () => {
    const work = await call('POST', `/api/workspaces/${workspaceA}/tasks`, memberA.cookie,
      { title: 'Member task', kind: 'agent_task', creatorGuestLabel: 'Member A' });
    expect(work.statusCode, work.body).toBe(201);

    const settings = await call('PATCH', `/api/workspaces/${workspaceA}`, memberA.cookie,
      { guidance: 'x' });
    expect(settings.statusCode).toBe(403);
    const invite = await call('POST', `/api/workspaces/${workspaceA}/invitations`, memberA.cookie, {});
    expect(invite.statusCode).toBe(403);
  });

  it('refuses to leave a workspace with nobody who can manage it', async () => {
    const solo = (await create(ownerA.cookie, 'Solo')).workspaceId;
    const demote = await call('PATCH', `/api/workspaces/${solo}/members/${ownerA.userId}`,
      ownerA.cookie, { role: 'member' });
    expect(demote.statusCode).toBe(403);
    const remove = await call('DELETE', `/api/workspaces/${solo}/members/${ownerA.userId}`, ownerA.cookie);
    expect(remove.statusCode).toBe(403);

    // With a second owner it is allowed, which is what makes the rule a
    // safeguard rather than a trap.
    const second = await signInAs(t.handle.db, { workspaceId: solo, role: 'owner', label: 'co-owner' });
    expect(second.userId).toBeTruthy();
    const now = await call('PATCH', `/api/workspaces/${solo}/members/${ownerA.userId}`,
      ownerA.cookie, { role: 'member' });
    expect(now.statusCode, now.body).toBe(204);
  });
});

describe('sessions', () => {
  it('treats an unknown, malformed, or truncated cookie as signed out', async () => {
    for (const value of ['', 'not-a-token', 'x'.repeat(400), `${SESSION_COOKIE}=`]) {
      const res = await call('PATCH', `/api/workspaces/${workspaceA}`,
        `${SESSION_COOKIE}=${value}`, { guidance: 'x' });
      expect(res.statusCode, value).toBe(401);
    }
  });

  it('stops accepting a session the moment it is signed out', async () => {
    const temp = await signInAs(t.handle.db, { workspaceId: workspaceA, role: 'member', label: 'temp' });
    expect((await call('POST', `/api/workspaces/${workspaceA}/tasks`, temp.cookie,
      { title: 'before', kind: 'agent_task', creatorGuestLabel: 'Temp' })).statusCode).toBe(201);

    const out = await call('DELETE', '/api/auth/session', temp.cookie);
    expect(out.statusCode).toBe(204);
    // Revocation is immediate, which is the reason for an opaque server
    // session rather than passing the provider's JWT around.
    expect((await call('POST', `/api/workspaces/${workspaceA}/tasks`, temp.cookie,
      { title: 'after', kind: 'agent_task', creatorGuestLabel: 'Temp' })).statusCode).toBe(401);
  });

  it('ignores an expired session', async () => {
    const expired = await signInAs(t.handle.db, { workspaceId: workspaceA, role: 'owner', label: 'expired' });
    await t.handle.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', expired.userId).execute();
    expect((await call('PATCH', `/api/workspaces/${workspaceA}`, expired.cookie,
      { guidance: 'x' })).statusCode).toBe(401);
  });
});

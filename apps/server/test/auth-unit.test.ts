import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@app/contracts';
import { readSessionCookie, registerAuthorization } from '../src/auth/authorize.js';
import { createSupabaseVerifier } from '../src/auth/supabase.js';
import type { SessionStore } from '../src/auth/sessions.js';
import { registerErrorHandler } from '../src/http/errors.js';

describe('session cookie parsing', () => {
  it.each(['%', '%ZZ', '%E0%A4%A'])('treats invalid escaping as signed out: %s', (value) => {
    expect(readSessionCookie(`${SESSION_COOKIE}=${value}`)).toBeUndefined();
  });

  it('reads quoted and encoded cookies alongside unrelated cookies', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}="valid%5Ftoken"; other=x`)).toBe('valid_token');
  });
});

describe('HEAD authorization', () => {
  it.each(['members', 'invitations'])('protects automatic HEAD for %s', async (suffix) => {
    const app = Fastify();
    registerErrorHandler(app);
    // The gate reads access and workspace state in one call, so a double that
    // only answers `access` makes the hook throw and the refusal arrive as a
    // 500 -- which is a failure to authorize dressed up as a server error.
    registerAuthorization(app, {
      resolve: vi.fn().mockResolvedValue(null),
      access: vi.fn().mockResolvedValue('viewer'),
      workspaceAccess: vi.fn().mockResolvedValue({
        access: 'viewer', exists: true, archived: false,
      }),
    } as unknown as SessionStore);
    app.get(`/api/workspaces/:workspaceId/${suffix}`, async () => ({ private: true }));
    try {
      const res = await app.inject({ method: 'HEAD',
        url: `/api/workspaces/11111111-1111-4111-8111-111111111111/${suffix}` });
      expect(res.statusCode).toBe(401);
    } finally { await app.close(); }
  });
});

describe('Supabase verification', () => {
  const config = { SUPABASE_URL: 'https://auth.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };

  it.each([null, [], 'unexpected', 42, {}])('rejects malformed provider payload %j as an auth error', async (payload) => {
    const verifier = createSupabaseVerifier(config, vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(verifier('test-token')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('verifies the provider token with a bounded request', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: '11111111-1111-4111-8111-111111111111', email: 'person@example.test',
      user_metadata: { full_name: '  Person\nName ' },
    }));
    const verified = await createSupabaseVerifier(config, fetcher)('test-token');
    expect(verified.displayName).toBe('Person Name');
    expect(fetcher).toHaveBeenCalledWith('https://auth.example.test/auth/v1/user', expect.objectContaining({
      headers: { apikey: 'sb_publishable_test', authorization: 'Bearer test-token' },
      signal: expect.any(AbortSignal),
    }));
  });
});

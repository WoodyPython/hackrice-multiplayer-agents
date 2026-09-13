# Accounts, membership, and roles

How signing in works, what each role may do, and what to configure.

Supabase Auth owns **identity**. This server owns **authorization**. Supabase
knows who someone is; it has no idea which workspaces they belong to, so
memberships, roles, and invitations are our tables and are checked by us.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | server | Project to verify access tokens against |
| `SUPABASE_PUBLISHABLE_KEY` | server | Sent with the verification call |
| `VITE_SUPABASE_URL` | browser | Same value; Vite only exposes `VITE_`-prefixed vars |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | browser | Same value; the browser signs in with it directly |

The publishable key is designed to be public and carries no authority on its
own. **Never** prefix `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` with
`VITE_`: that would ship a server credential to every visitor.

Without these, the app still runs and the API still enforces membership. Only
signing in fails, with a message naming the variables.

### One dashboard setting

Supabase requires email confirmation by default (`mailer_autoconfirm: false`),
and the free-tier mailer is rate-limited to a handful of messages per hour. For
a demo, turn **Confirm email** off in Authentication → Providers → Email so
accounts work instantly. Turn it back on afterwards. The sign-up screen handles
both: when Supabase returns a user without a session it says "check your email"
rather than pretending the person is signed in.

## How a session is established

1. The browser signs in with Supabase directly. Passwords never reach this
   server.
2. It posts the resulting access token to `POST /api/auth/session` **once**.
3. The server verifies that token against Supabase, upserts the account, and
   replies with an opaque session in an `HttpOnly` cookie.
4. The provider token is then discarded. Everything after this is the cookie.

### Why a cookie, and why our own session

`EventSource` cannot set headers, and neither can a browser WebSocket upgrade.
This app uses both — the refresh/presence stream and the Yjs document socket. A
bearer token would have authorized `fetch` and left those two open. A cookie is
carried by all three transports, so there is one authentication path rather than
one that works and two that silently do not.

Keeping our own session rather than passing Supabase's JWT around also means
signing out takes effect immediately, and the provider token never has to live
in browser storage.

## Roles

| | viewer | member | owner |
|---|---|---|---|
| Read tasks, files, history | ✅ | ✅ | ✅ |
| Appear in presence | ✅ | ✅ | ✅ |
| See the member list | ❌ | ✅ | ✅ |
| See member email addresses | ❌ | ❌ | ✅ |
| Create and run tasks, edit documents, apply reviews | ❌ | ✅ | ✅ |
| Mark a task complete | ❌ | ✅ | ✅ |
| Move a task to another state | ❌ | ❌ | ✅ |
| Workspace settings and guidance | ❌ | ❌ | ✅ |
| Invite, change roles, remove people | ❌ | ❌ | ✅ |

**viewer** is anyone holding the workspace link who is not a member, signed in
or not. It exists so progress can be shared outside the team, and it is the
weaker path, so writes are denied by default rather than allowed by omission.

## Where enforcement lives

One `preHandler` in `apps/server/src/auth/authorize.ts`, in front of every route
under `/api/workspaces/:workspaceId` — which is 45 of the 46 routes. It matches
the **registered route pattern**, never the raw URL, so no encoding or traversal
trick can disguise a path.

The requirement is derived from the method: anything that is not `GET` or `HEAD`
needs membership. Exceptions are listed explicitly in that file. **A mutating
route added later is therefore member-only before anyone remembers to think
about it**, and `permissions.test.ts` proves it by registering a brand-new route
after boot and asserting it is refused.

The WebSocket upgrade is the one surface a `preHandler` cannot reach, so it
authorizes explicitly in `recovery/runtime.ts` against the same session store.

## Invitations

Single-use, expiring after seven days, hashed at rest, and optionally locked to
one email address. The token is returned **once**, at creation; only its hash is
stored, so the invitation list cannot reproduce a working link.

The workspace URL grants nothing. The token is the credential.

## Migrating a workspace made before accounts

Such a workspace still has its `owner_key_hash`. Somebody signed in who holds
that key can claim it, becoming its owner; the hash is then cleared, so a key
shared in a chat months ago stops working.

**Ownership is never granted from a workspace URL.** Everyone the link was ever
sent to has it, and honouring it would hand each old workspace to whoever opened
it first. Contributors who were not the key holder need an invitation from the
new owner — there is no credential that identifies them, and inventing one would
mean trusting a self-asserted label, which design section 1.3 rules out.

## Relationship to the MVP design

This supersedes the anonymous model in sections 1.2, 1.3, and 5.1. Those
sections describe a system with "no participant identities", where "ownership
belongs to possession of that browser key" and presence is limited to open
documents. Accounts replace that basis deliberately, as a post-MVP change.

What carries over unchanged: display names are still never authority (they now
come from a verified account instead of a text field), hiding a control is still
never the enforcement, and nothing an agent produces reaches approved files
without a person applying it.

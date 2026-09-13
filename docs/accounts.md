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
| `SUPABASE_SECRET_KEY` | server | Creates already-confirmed username identities |
| `VITE_SUPABASE_URL` | browser | Same value; Vite only exposes `VITE_`-prefixed vars |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | browser | Same value; the browser signs in with it directly |

The publishable key is designed to be public and carries no authority on its
own. **Never** prefix `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` with
`VITE_`: that would ship a server credential to every visitor.

Without these, the app still runs and the API still enforces membership. Only
signing in and account creation fail.

### Username identities

CoFlow maps each username to a private email-shaped identifier for Supabase and
creates it as already confirmed through the server. No email provider,
confirmation setting, or SMTP setup is needed.

## How a session is established

1. Existing accounts sign in with Supabase directly using the private identifier
   derived from the username. New accounts are created through the server so
   they can be marked confirmed without an email round trip.
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

The product calls the workspace administrator a **host**. The stored role value
remains `owner` for database and API compatibility.

| | viewer | member | host |
|---|---|---|---|
| Read tasks, files, history | ✅ | ✅ | ✅ |
| Appear in presence | ✅ | ✅ | ✅ |
| See the member list | ❌ | ✅ | ✅ |
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

## Finding your workspaces again

This is what accounts are actually for, and it is worth being precise about
what changed. Workspace *data* was always durable — a workspace is a Postgres
row and has been since the first migration. What was not durable was the route
back to one: the URL in somebody's chat log, plus an owner key in one browser's
localStorage. A cleared browser or a lost link lost the room.

Two lists answer "where do I work", and they are deliberately different things:

| | Where it comes from | What it grants |
|---|---|---|
| **Your workspaces** | `workspace_members` | Everything the role allows |
| **Opened by link** | `workspace_visits` | Nothing. It restores the address |

`GET /api/auth/workspaces` returns both. A visit is recorded when a signed-in
account reads a workspace, throttled to one write per five minutes, and is
private to the person it belongs to. **It is not a weaker membership.** Every
request it leads to is authorized against `workspace_members` exactly as
before, so a link holder who can now find a workspace again is still a viewer
in it. The alternative — treating "has opened this" as any kind of standing —
is the same mistake as treating the URL as ownership, which the claim flow
below exists to avoid.

Ordering is by last activity, not by name: `workspaces.last_activity_at`, which
the event pump touches when a durable task event lands. `updated_at` was never
a substitute — it moves when an owner renames the workspace and stays still
through a week of real work.

## Archiving, leaving, deleting

Three different intentions, which until now all had the same answer: nothing.

**Archive** (host) is reversible and keeps everything. The workspace leaves the
switcher, appears under Archived on the home page, reads normally, and refuses
every write. The refusal is in the same `preHandler` that enforces membership,
so a route added later is covered before anyone thinks about it; the exceptions
are restore, delete, and leave, listed explicitly in `auth/authorize.ts`. The
error code is `WORKSPACE_ARCHIVED` (409) rather than `FORBIDDEN` (403), because
the request is refused by the state of the thing and not by who is asking — a
member told they lack a permission they actually have would go looking in the
wrong place.

**Leave** (any member) removes only you, and clears your last-workspace pointer
if it named this one. The last host cannot leave, for the same reason they
cannot demote themselves: a workspace nobody can administer can never be
invited into, archived, or deleted by anybody.

**Delete** (host) is real and permanent: the row, everything cascading from it,
the Git repository, and the uploaded objects. A soft delete was considered and
rejected — it reclaims nothing, and reclaiming is the reason this exists. The
caller types the workspace's name back, checked server-side; that is not the
authorization, which the gate has already settled, but the gap between meaning
to do this and having clicked the wrong row.

## Housekeeping

`npm run workspace:gc --workspace @app/server` reports what is taking up room:
database size against the free plan's 500 MB, then workspaces sorted into
`orphaned` (pre-accounts, unclaimed, no members — nothing can administer them
but a key in some browser's storage), `empty`, and long-archived, plus
repository directories with no workspace row.

**It changes nothing without `--delete`.** Which workspaces are junk is a
judgement about what the team is doing this week, not something a heuristic
should decide, and a workspace with members and content is never listed at any
age. `--ids` is there for when a person has decided.

## Invitations

Single-use, expiring after seven days, and hashed at rest. The token is returned
**once**, at creation; only its hash is stored, so the invitation list cannot
reproduce a working link.

The workspace URL grants nothing. The token is the credential.

## Migrating a workspace made before accounts

Such a workspace still has its `owner_key_hash`. Somebody signed in who holds
that key can claim it, becoming its host; the hash is then cleared, so a key
shared in a chat months ago stops working.

**Ownership is never granted from a workspace URL.** Everyone the link was ever
sent to has it, and honouring it would hand each old workspace to whoever opened
it first. Contributors who were not the key holder need an invitation from the
new host — there is no credential that identifies them, and inventing one would
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

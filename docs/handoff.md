# Handoff — CoFlow

Written for someone picking this up cold. It covers what the project is, the
decisions that are load-bearing, the traps that have already cost time, and how
to work on it without breaking the team.

Start by reading `hackrice-final-mvp-design.md` only when you need a specific
section — it is 1,500 lines and mostly still accurate, with the exceptions
listed under **Superseded design** below. `docs/CHANGELOG.md` is newest-first
and is where each landed change explains itself.

## What this is

A shared workspace where people write together and AI agents do assigned work
alongside them. Someone posts a task; an orchestrator model plans it; worker
agents run in parallel on isolated Git branches; nothing they produce reaches
the shared files until a person reads a diff and applies it.

The differentiator, and the thing to protect in any decision: **Git provides
the safety properties, and the interface spends them without ever making a user
learn Git.** Contributors never see a branch, a merge, or a commit hash.

## Layout

```
apps/server      Fastify + Kysely/Postgres. Agents, Git, reviews, auth.
apps/web         React + Vite + Tailwind v4. shadcn-style tokens.
packages/contracts  Zod schemas shared by both. The vocabulary.
db/migrations    Numbered SQL, checksummed by the runner.
```

Server subsystems worth knowing by name: `auth/` (sessions and the permission
gate), `agents/` (token ledger, execution scopes), `orchestration/` (planner,
scheduler, start), `workers/` (the agent tool loop), `git/` (worktrees,
reviews, apply), `collaboration/` (Yjs rooms), `briefings/` and `inbox/`
(newer, teammate-built).

## The five things that will bite you

**1. Gemini free tier is 20 requests per day, per model.**
`quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`. One task run
costs 6–8 worker requests, so a free key supports two or three runs *a day*.
When agents "stop working", check this first — the symptom is a writer making
one call and then backing off forever. `ORCHESTRATOR_MODEL` and `WORKER_MODEL`
have separate buckets, which is why planning keeps working while every subagent
dies. **Enable billing** on the Google Cloud project; no code change fixes it.
Diagnose with `npm run gemini:smoke --workspace @app/server`.

**2. Authorization is one hook, and that is deliberate.**
`apps/server/src/auth/authorize.ts` runs in front of every route under
`/api/workspaces/:workspaceId` — 48 of the 49 routes. It derives the
requirement from the HTTP method: **anything that is not GET/HEAD needs
membership**, with exceptions listed explicitly in that file. Add a mutating
route and it is member-only before you think about it. Do not add per-handler
permission checks; extend the lists in that file instead.

**3. The session is a cookie because it has to be.**
`EventSource` cannot set headers and neither can a browser WebSocket upgrade.
This app uses both (the refresh/presence SSE stream and the Yjs document
socket). A bearer token would authorize `fetch` and silently leave those two
open. The WebSocket upgrade is not a Fastify route, so it authorizes explicitly
in `recovery/runtime.ts` — if you touch live documents, keep that.

**4. Tests are signed in by default, and one suite deliberately is not.**
`buildTestApp` attaches a fixture owner's cookie to any `inject` that does not
bring its own, so ~180 existing assertions keep testing their own subject.
`permissions.test.ts` passes `authenticate: false` precisely so it cannot
inherit an identity. **If you are testing who may do what, do it there.**
Suites that build their own runtime call `authenticateRuntime(app, db)`, and
WebSocket clients use an `AuthenticatedWebSocket` subclass (`ws` can set
headers on a handshake even though a browser cannot).

**5. A React provider that builds its own dependency inline loops forever.**
`AuthProvider` had `api = new AuthApi(...)` as a default *parameter*, so a new
instance per render, so a new `useCallback`, so the mount effect re-ran: 300+
`GET /api/auth/session` per page load. Every test passes a stable `api`, and
every request returned 200, so neither the suite nor the browser complained.
Fixed, but the shape is worth recognising — check the network panel once when
touching a provider.

**6. New web test files need `stubAuthApi`.**
`<App/>` without an `authApi` prop makes `AuthProvider` issue a real `fetch`
that never settles under jsdom; the test times out at 5s with no useful error.
This has now bitten four separate test files. `import { stubAuthApi } from
"./test-auth"` and pass `authApi={stubAuthApi()}`.

## Configuration

Copy `.env.example`. The parts that matter:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase session pooler (port 5432, not 6543) |
| `TEST_DATABASE_URL` | Separate DB, wiped and re-migrated per test run |
| `GEMINI_API_KEY` | See trap 1. Enable billing. |
| `ORCHESTRATOR_MODEL` / `WORKER_MODEL` | Both Flash on purpose; a free key has `limit: 0` for Pro |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Username/password sign-in and server-side token verification |
| `SUPABASE_SECRET_KEY` | Confirmed username account creation; server only |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Same values, for the browser |

**Never** prefix `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` with
`VITE_` — that ships a server credential to every visitor.

CoFlow creates synthetic username identities through the server and confirms
them immediately, so no email-confirmation dashboard setting or SMTP setup is
needed. `docs/accounts.md` has the full auth picture.

## Running it

```bash
npm install                                   # required after any pull that touches deps
npm run db:migrate --workspace @app/server
npm run dev                                   # server
npm run dev --workspace @app/web              # frontend
```

`npm install` is not optional — a missing dependency has twice left the web
suite and dev server dead on a fresh checkout with a confusing error.

## Testing

**Do not run the full suite.** It takes many minutes and the team will be
waiting. Run the focused config for what you touched:

```bash
npm run test:models --workspace @app/server      # no DB, no network
npm run test:agents --workspace @app/server
npm run test:workers --workspace @app/server
npm run test:planning|scheduler|start|review|retry|git --workspace @app/server
node scripts/test.mjs run <file>.test.ts         # one file, from apps/server
npx vitest run src/<file>.test.tsx               # one file, from apps/web
```

`apps/server/test/permissions.test.ts` is the security suite — run it for any
change to routes, roles, or sessions. `apps/web` is ~25s for everything, which
is cheap enough to run whole.

## Superseded design

The MVP design document predates accounts. These sections are no longer true:

- **§1.2 / §1.3 (anonymous participation, owner key, no identities)** —
  replaced by accounts, workspace memberships, and owner/member roles. The
  owner key survives *only* as proof for claiming a pre-accounts workspace, and
  is cleared once used.
- **§5.1 (no participant identities)** — presence is now per workspace, and the
  host marker is derived server-side from membership, never asserted by the
  client.
- **§10.3 (owner apply)** — applying a review is open to any member. This was a
  deliberate product decision; the reasoning is in the commit and in
  `docs/accounts.md`.
- **§4.6 (review is requested, never automatic)** — still true, and worth
  keeping. The banner makes asking one obvious click rather than removing it.

What carries over unchanged: a display name is never authority, hiding a
control is never the enforcement, generated content is never executed, and
nothing an agent writes reaches approved files without a person applying it.

## Working with the team

Several people push to `main` directly and merges are frequent. What has
actually gone wrong, more than once:

- **A semantic conflict that cost the owner their own controls.** The accounts
  merge left `isOwner` ANDed with a legacy owner key in browser storage. New
  workspaces have no such key, so the flag was never true and the creator of a
  workspace could not open its settings or invite anybody. Both sides compiled,
  both sides' tests passed. Ownership is `workspace.access` now.

- **A teammate changes a fixture and misses assertions that depend on it.**
  Before assuming a failure is yours, check whether it predates your work —
  `git log -S'<the failing string>'` finds who introduced it fast.
- **Semantic conflicts git cannot flag.** Both sides compile and merge cleanly
  while meaning something different. The ones that actually happened: a removed
  prop still being passed, a client-asserted `isHost` badge, two migrations
  numbered `0011`, and `credentials: true` being silently dropped from CORS
  (which would have broken all authentication).
- **Renumber your own migration on a collision**, not theirs — theirs may
  already be applied elsewhere.
- **RLS does not inherit.** `0004` enables row-level security on the tables
  existing then. Any new table needs its own `enable row level security`; this
  is a Supabase database and PostgREST exposes public tables to `anon` by
  default. `schema.test.ts` will catch you.

## Current state

All suites green. 42 server test files and 16 web ones; web is 177 tests.

Workspaces have a full lifecycle as of 2026-09-13 — a home page listing
everything an account can reach, archive/restore, leave, delete, and
`npm run workspace:gc --workspace @app/server` for what is taking up room.

Nothing is deployed — the project has never been pushed to a host, and
`render.yaml` is untested.

Known rough edges, none blocking:

- The frontend does not surface `agent.waiting` / `provider_backoff` events, so
  a rate-limited run looks like a run that is simply thinking. The durable
  events exist; only the UI is missing.
- A writer agent's first model call is usually a `read_file` on a file it is
  about to create, which returns null. That is ~20% of a writer's request
  budget spent learning nothing. Prompt-only fix, untested because quota was
  exhausted when it was found.
- The hosted database holds 18 workspaces from testing, all created before
  accounts: unclaimed, memberless, and reachable only by whoever still has the
  link. 13 MB of the free plan's 500 MB, so not urgent — but `workspace:gc`
  lists them under `orphaned` and they are the obvious first sweep.
- `docs/pitfalls.md` is worth skimming before a deep change; it records
  mistakes with their causes.

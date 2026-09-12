# Team setup

Get to the exact same state as everyone else, verify it, and start your first
ticket. Budget 10 minutes.

If anything here doesn't work, the [Troubleshooting](#troubleshooting) section
covers every failure we've actually hit.

---

## 1. Prerequisites

Install these three. Nothing else.

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **22 or newer** | The codebase is ESM with `NodeNext` module resolution and runs TypeScript directly through `tsx`. Node 20 fails on module resolution with a confusing error |
| **Docker Desktop** | any current | This is how you get PostgreSQL. See below |
| **Git** | **2.29 or newer** | Bare repositories with explicit main branch and SHA-1 format |

Check:

```bash
node --version && docker --version && git --version
```

### You do NOT need

- **PostgreSQL installed locally.** Docker provides it.
- **`psql`.** Migrations run through a Node script.
- **The Supabase CLI.** Not a dependency for anyone.

### Why Docker, specifically

`docker-compose.yml` pins **postgres:15-alpine**, which matches the major
version Supabase runs. That isn't incidental. The schema uses `NULLS NOT
DISTINCT` (PostgreSQL 15+) on the material-attachment dedupe index, plus enum
ordering and partial indexes. On PostgreSQL 14 that index silently fails to
compile, and you'd be developing against a different schema than production.

Docker Desktop must actually be **running**, not just installed. On Windows and
macOS it does not start with the machine unless you enable that.

---

## 2. Clone and install

```bash
git clone https://github.com/WoodyPython/hackrice-multiplayer-agents.git
cd hackrice-multiplayer-agents
npm install
```

> **Run `npm install` at the repository root.** Never inside `apps/server` or
> `packages/contracts`. This is an npm workspaces monorepo: the root install
> hoists dependencies and symlinks `@app/contracts` into each package.
> Installing inside a subfolder breaks that link and you'll get
> `Cannot find module '@app/contracts'`.

A `postinstall` hook builds `@app/contracts` for you, so imports resolve
immediately with no separate build step.

---

## 3. Configure and start the database

```bash
cp .env.example .env
npm run db:up
npm run db:migrate
```

- `cp .env.example .env` — the defaults work out of the box. `DATABASE_URL`
  points at **port 54322**, deliberately not 5432, so it won't collide if you
  already run PostgreSQL locally. **Never commit `.env`.**
- `npm run db:up` — starts the container.
- `npm run db:migrate` — applies the four SQL files in `db/migrations`.

Expected output:

```
  applying 0001_enums.sql ... ok
  applying 0002_tables.sql ... ok
  applying 0003_indexes.sql ... ok
  applying 0004_rls.sql ... ok
Applied 4 migration(s).
```

---

## 4. Verify

```bash
npm test
```

**Expected: all tests pass, including the D01 Git and runtime checks.**

This is the real check. The suite exercises every uniqueness rule, foreign
key, and check constraint in the schema against a live PostgreSQL, plus the
workspace API: owner-key isolation, log redaction, and version guards, plus D01's
persistent repositories and runtime lifecycle. If they all
pass, your environment matches everyone else's. If they don't, stop and fix it
before writing code — don't work around it.

`npm test` builds a separate `app_test` database, so it never touches your
development data.

Optional, confirms TypeScript is happy across both packages:

```bash
npm run build
```

---

## 5. Start your ticket

Ticket definitions are in
[hackrice-final-mvp-design.md](hackrice-final-mvp-design.md) section 16.

B01 is done, which unblocks the first ticket for all three of you.

*The table below is the original starting point, written when B01 landed. It is
kept as onboarding context and is no longer a status report — for where things
actually stand, read [`docs/CHANGELOG.md`](docs/CHANGELOG.md) newest-first and
the status table in [`docs/handoff-b08.md`](docs/handoff-b08.md).*

| You | Start with | What B01 gives you |
|---|---|---|
| **Role A** — Frontend | **A01** Workspace/task UI shell | A01 says "using contract-shaped fixtures" — that's `TaskSummary`, `TaskDetail`, all 10 `TASK_STATUSES` for board columns, and 26 error codes so error states are real states, not generic banners |
| **Role C** — Gemini | **C01** Adapter and model routing | `AGENT_PRESETS`, `AGENT_TIMEOUT_MS`, `TASK_AGENT_TOKEN_BUDGET`, `modelUsageSchema`, the `AgentService` interface, and `agentPlanSchema` with the four graph checks Zod can't express documented inline |
| **Role D** — Git/runtime | **D01** Persistent runtime and Git init | The `GitService` interface, the `workspaces` table, `GIT_DATA_ROOT`, and the `runs` / `draft_files` / `draft_checkpoints` shapes D02–D04 build against |

Branch per ticket:

```bash
git checkout -b role-c/c01-gemini-adapter
```

Roles own disjoint directories by design (design section 15.1), so if nobody
wanders outside their own, merge conflicts should be near zero.

| Path | Owner |
|---|---|
| `apps/web/**` | A |
| `apps/server/src/{workspaces,tasks,discussion,materials,db,events}` | B |
| `apps/server/src/http`, `apps/server/src/config.ts` | B |
| `apps/server/src/index.ts`, deployment/runtime configuration | D |
| `apps/server/src/{models,orchestration,agents}` | C |
| `apps/server/src/{git,collaboration,reviews,recovery}` | D |
| `packages/contracts`, `db/migrations` | B (everyone consumes) |

### Environment values you'll need to add

`.env.example` lists everything. Role C needs a real `GEMINI_API_KEY` locally.
Supabase values (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are only needed
for B04/B06 and will be distributed once the project exists — local PostgreSQL
covers everything until then.

---

## Before you wire against the API

Read [docs/interfaces/](docs/interfaces) for your role: the error envelope, the owner-key header, which status codes carry meaning beyond success, and the contracts each hook must honour.

Then skim [docs/CHANGELOG.md](docs/CHANGELOG.md) from wherever you last left off. Every entry says in one line whether it needs anything from you. [docs/README.md](docs/README.md) has the full procedure for landing and picking up work.

## Three rules

### 1. Never edit an applied migration

The runner records a SHA-256 of every file it applies. Edit one and your next
`npm run db:migrate` aborts:

```
Already-applied migrations were edited: 0002_tables.sql
```

That guard is what stops two people's schemas silently diverging. Fix forward
with a new numbered file. To start clean locally:

```bash
npm run db:reset && npm run db:migrate
```

Schema changes go through Role B. Need a column? Ask — it's a two-minute change
and it keeps `db/migrations`, `packages/contracts/src/enums.ts`, and
`apps/server/src/db/types.ts` in sync. A test asserts the database enums match
the contracts package, so drift fails CI rather than surfacing at runtime.

### 2. `packages/contracts` is additive-only

Add fields, schemas, and error codes freely. **Do not rename or remove
anything** until integration — a rename there breaks three branches at once.

### 3. Import shared types, don't redeclare them

```ts
import {
  type TaskStatus,
  type PostedTask,
  TASK_STATUSES,
  ApiError,
  AGENT_TIMEOUT_MS,
} from '@app/contracts';
```

If you find yourself writing a type that already exists in `@app/contracts`,
import it instead. That package is the reason the editor, API, and Git service
will agree on the freshness tuple later.

---

## Troubleshooting

**`error during connect: ... dockerDesktopLinuxEngine: The system cannot find the file specified`**
Docker Desktop is installed but not running. Launch it, wait for the whale icon
to stop animating, then retry. Verify with `docker version`.

**`Cannot find module '@app/contracts'`**
You ran `npm install` inside a subfolder, or deleted `packages/contracts/dist`.
Fix from the repository root:

```bash
npm install && npm run build
```

**`npm error ERESOLVE could not resolve` / peer dependency conflict**
Stale lockfile. From the root:

```bash
rm -rf node_modules package-lock.json && npm install
```

Then tell Role B — a regenerated lockfile should be committed so everyone stays
on the same tree.

**`npm run db:up` fails with a port conflict**
Something already holds 54322. Either stop it, or change the port in
`docker-compose.yml` **and** the `DATABASE_URL` port in your `.env`.

**Migration fails with `type "task_status" already exists`**
A partial previous run. Reset:

```bash
npm run db:reset && npm run db:migrate
```

**Tests fail with `database "app_test" does not exist`**
Normal on first run — the suite creates it. If it persists, the container isn't
healthy: `docker compose ps` and check the `db` service.

**Tests hang on startup**
A previous crashed run left connections open. `npm run db:reset`.

**Everything installed, tests still fail**
Post the full output. Don't work around a failing schema test — it means your
database doesn't match the schema, and anything you build on it is built wrong.

---

## Daily commands

| Command | Does |
|---|---|
| `npm run db:up` | Start PostgreSQL |
| `npm run db:down` | Stop it (keeps data) |
| `npm run db:reset` | Wipe and recreate (destroys local data) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:status` | Show applied / pending / drifted |
| `npm test` | Run the suite |
| `npm run build` | Typecheck and build both packages |
| `npm run dev` | Start the server with TypeScript watch/restart |
| `npm start` | Start the compiled server after building |
| `npm run test:git --workspace @app/server` | Run D01's Git tests without PostgreSQL |

After any `git pull`, run `npm install && npm run db:migrate` — someone may have
added a dependency or a migration.

## D01 runtime

Use Node.js 22+ and Git 2.29+ (D01 uses explicit initial-branch and SHA-1
object-format options). On Windows PowerShell, use `npm.cmd` in place of `npm`
if the execution policy blocks `npm.ps1`.

From the repository root, configure `.env`, start the database, apply migrations,
then run `npm run dev`. For the compiled runtime, run `npm run build` followed by
`npm start`. Root and server-workspace scripts both load the repository-root
`.env`; environment variables supplied by the host take precedence. Blank
optional Supabase/Gemini values in the template are treated as unset.

The server binds `0.0.0.0:PORT` (default 3000). `GET /health` returns
`{ "status": "ok", "bootId": "..." }`; the boot ID changes with each process.
Startup checks Git, writable storage, and database connectivity before listening.
It does not apply migrations automatically.

`GIT_DATA_ROOT=./data` resolves relative to the repository root, even when npm
runs inside `apps/server`. Absolute paths are also supported. The runtime creates:

- `repos/<workspace-uuid>.git`: a bare repository with a server-authored empty
  initial commit on `main`.
- `worktrees/`: reserved for D02's scoped worktrees.

Workspace creation returns 201 independently of Git initialization. Its hook
starts initialization in the background; the Git service retries on first access
if needed. Hook errors contain a workspace ID and safe error code. Corrupt or
non-bare repository targets fail without being replaced. Investigate these
offline; do not delete a workspace repository to retry an operation.

On Render, mount the persistent disk at `/data` and set `GIT_DATA_ROOT=/data`.
Use one application process and one instance for that root; process-local Git
locks do not coordinate multiple replicas. Retain the same disk across deploys.
Do not place live repositories on an ephemeral build filesystem or in object
storage. Deployment provisioning remains a separate action.

`SIGINT`/`SIGTERM` close live attachments, drain HTTP requests and repository
initialization, then close the database. D03 attaches the live-document server
on the same `app.server` by default and flushes dirty rooms before database
cleanup. See [the connection contract](docs/interfaces/git.md#shared-documents-d03).

D02 should reuse the singleton `LocalGitService.withRepository(workspaceId,
callback)` for accesses and mutations after resolving the workspace record. It
ensures the repository while holding the workspace lock. Its callback already
owns that lock: do not re-enter `initialize`, `ensureRepository`, or
`withRepository` from inside it. Internal repository paths never belong in HTTP
responses or agent context. The operation lock precedes any task document gate.

Verification: `npm run test:git --workspace @app/server` needs only Git and local
temporary storage. `npm test` additionally exercises real HTTP/runtime and
PostgreSQL integration. To check persistence manually, create a workspace via
`POST /api/workspaces`, wait for its repository, record `main` with
`git --git-dir=data/repos/<workspace-uuid>.git rev-parse main`, restart the server,
and verify the same SHA with a different `/health` boot ID.

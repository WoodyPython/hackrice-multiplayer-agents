# Collaborative Task Workspace

Anonymous collaborators create tasks, discuss requirements, and co-edit drafts.
An explicit **Start** action freezes a snapshot and dispatches parallel Gemini
agents. The workspace creator reviews the exact combined result and applies it.

**New here? Start with [SETUP.md](SETUP.md).** Working alongside other roles? [docs/](docs) has the changelog, the per-role interface notes, and the handoff procedure.

Full specification: [hackrice-final-mvp-design.md](hackrice-final-mvp-design.md).

Role C integration: [model adapter](apps/server/src/models/README.md) and
[C02 budgets/deadlines](apps/server/src/agents/README.md).

## Getting started

```bash
npm install
cp .env.example .env
npm run db:up          # local Postgres 15 in Docker on port 54322
npm run db:migrate
npm test
```

`npm test` creates and migrates a separate `app_test` database, so it never
touches development data.

After configuring `.env` and applying migrations, run `npm run dev` for the
server, or `npm run build && npm start` for the compiled runtime. The API listens
on port 3000 by default; `GET /health` returns its process boot ID.

Git repositories persist under `GIT_DATA_ROOT` (default: repository-root
`data/`, regardless of the launch directory). Run exactly one runtime process
against a data root. Production must mount persistent storage there; see the
[D01 runtime notes](SETUP.md#d01-runtime).

## Layout

| Path | Owner | Contents |
|---|---|---|
| `packages/contracts` | B | Zod schemas, status enums, error codes, service interfaces. Consumed by every role |
| `db/migrations` | B | Plain SQL, forward-only, immutable once applied |
| `apps/server/src/db` | B | Kysely client, hand-written schema types, migration runner |
| `apps/server/src/{http,config.ts}` | B | Non-listening application factory and configuration |
| `apps/server/src/index.ts` | D | Process startup, shared HTTP server, and shutdown |
| `apps/server/src/{workspaces,tasks,discussion,materials,events}` | B | Application data APIs |
| `apps/server/src/{models,orchestration,agents}` | C | Gemini adapter, budgets, planning, dispatch |
| `apps/server/src/{git,collaboration,reviews,recovery}` | D | Git service, Yjs rooms, review and apply |
| `apps/web` | A | React frontend |

## Working with the schema

`db/migrations` is the source of truth. The runner records a checksum per file
and refuses to run if an already-applied file was edited, so everyone's database
matches. Fix forward with a new numbered file; to start clean locally:

```bash
npm run db:reset && npm run db:migrate
```

Three files move together and must change in the same commit:

- `db/migrations/0001_enums.sql`
- `packages/contracts/src/enums.ts`
- `apps/server/src/db/types.ts`

`apps/server/test/schema.test.ts` asserts the database enums match the contracts
package, so drift fails a test rather than surfacing at runtime.

## Contracts are additive-only

Until integration, add to `packages/contracts` freely but do not rename or
remove anything. A rename there breaks three branches at once.

## Conventions that are load-bearing

- **Every uniqueness rule lives in the database.** Partial unique indexes and
  composite foreign keys, not application checks. Services translate a `23505`
  on a named constraint into the matching error code from design section 12.5,
  rather than doing a racy `SELECT` then `INSERT`.
- **IDs are UUIDs and are validated at every route boundary.** They end up in
  filesystem paths and Yjs room names; a caller must never be able to pass a
  path segment.
- **The owner key is the only privilege boundary.** It travels in the
  `x-owner-key` header, is compared against a stored SHA-256 in constant time,
  and is never logged. An `isOwner` flag in a request body is never accepted.
- **Never commit `.env`.**

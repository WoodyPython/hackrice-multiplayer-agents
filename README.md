# Collaborative Task Workspace

Anonymous collaborators create tasks, discuss requirements, and co-edit drafts.
An explicit **Start** action freezes a snapshot and dispatches parallel Gemini
agents. The workspace creator reviews the exact combined result and applies it.

**New here? Start with [SETUP.md](SETUP.md).**

Full specification: [hackrice-final-mvp-design.md](hackrice-final-mvp-design.md).

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

## Layout

| Path | Owner | Contents |
|---|---|---|
| `packages/contracts` | B | Zod schemas, status enums, error codes, service interfaces. Consumed by every role |
| `db/migrations` | B | Plain SQL, forward-only, immutable once applied |
| `apps/server/src/db` | B | Kysely client, hand-written schema types, migration runner |
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

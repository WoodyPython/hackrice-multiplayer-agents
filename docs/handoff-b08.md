# Handoff: B08 and integration

For whoever picks up Role B from here. Written at the point where B01–B07 are
done and B08 is the only Role B ticket left.

---

## Orientation, in order

1. **`hackrice-final-mvp-design.md`** — the specification. It has been amended
   throughout implementation and describes the system as built, not as planned.
   Where anything disagrees with it, it wins.
2. **`SETUP.md`** — get running. Ends at a passing test suite.
3. **`docs/README.md`** — the handoff procedure. Read it before landing
   anything; updating the changelog and interface notes is part of finishing a
   ticket, not cleanup afterwards.
4. **`docs/pitfalls.md`** — every bug that cost real time here. Short on
   purpose. Most of them were invisible-until-they-weren't, which is the point.
5. **`docs/interfaces/`** — what each role may call.

## Where things stand

| Role | Done | Remaining |
|---|---|---|
| A | A01, A02 | A03–A08 |
| **B** | **B01–B07** | **B08 only** |
| C | C01–C04 | C05–C08 |
| D | D01–D04 | D05–D08 |

**B08 is blocked.** It depends on B04, B06, B07 (done) plus **C07 and D07**,
which are four and three tickets away respectively. You cannot start the ticket
as written. What you *can* do is below.

## B08 itself

> Verify workspace/object scoping, owner-key isolation, material reuse, version
> guards, and discussion persistence across refresh.

It is a verification ticket, not a feature. Most of those properties already
have tests in the suites B01–B07 shipped. What B08 adds is **cross-flow**
verification: the same property holding through a real sequence, not in
isolation. Post a task, attach a material, start it, let an agent write, review,
apply — then check scoping still holds.

That needs C07 and D07 to exist. Until then:

### Useful work that is not blocked

**Supabase is set up and verified** as of 2026-09-12, so this is no longer the
open task it was. All six migrations are applied to the hosted project and
`npm run supabase:smoke --workspace @app/server` passes all four checks.

It was worth doing early: storage *was* broken. `SupabaseBlobStore.get` could
not recognise a missing object, because Supabase Storage answers 400 rather than
404 — precisely the "discovered broken during a deploy" outcome the task existed
to pre-empt. Details in the CHANGELOG and `pitfalls.md`.

Re-run the smoke command after anyone rotates a key or renames the bucket. It is
the quickest way to tell a configuration problem from a code one.

**Watch the build on `main`.** It broke once already — see below.

**Do not start other roles' tickets.** The role split is what has kept merge
conflicts near zero across four people.

## Things that will bite you

**`main` broke once from a bad merge.** `5c483af` resolved a conflict between
C04 and D04 in `git/service.ts` by keeping C04's addition and silently dropping
D04's `withDraftCapture` method — while leaving its doc comment and every caller
in place. The build was broken on `origin/main` for a while and nobody noticed,
because each author had verified their own branch.

The lesson, and it will recur: **after any merge involving two roles touching
one file, run `npm run build` and the full suite before pushing.** A green branch
plus a green branch is not a green merge.

**The suite is slow and has one known flake.** `git-files.test.ts` takes
**237–330 seconds** and times out at the shared 30-second per-test limit in
roughly one run in three when run alone. It is Role D's test; `testTimeout` is in
Role B's `apps/server/vitest.config.ts`. Documented in `pitfalls.md`, not fixed —
raising the limit hides it, and a single test needing tens of seconds is worth
understanding first.

Practical consequence: a full run takes minutes. Budget for it, and do not
interpret a single Git-suite failure as a regression without re-running.

**Two roles write `task_agent_budgets`... no, exactly one does now.** C02 and
B07 both shipped a ledger; they were consolidated onto Role C's `PgAgentLedger`
in `src/agents`. If you find yourself writing budget arithmetic in `src/runs`,
stop — that is the duplication that was already removed once.

## What Role B owns

```
packages/contracts          schemas, enums, error codes, service interfaces
db/migrations               plain SQL, forward-only, immutable once applied
apps/server/src/db          Kysely client, schema types, migration runner
apps/server/src/http        application factory, error mapping, serialization
apps/server/src/config.ts   environment, boot ID
apps/server/src/workspaces  anonymous workspaces, owner key
apps/server/src/tasks       post/revise/start/cancel/retry, transitions
apps/server/src/discussion  task discussion, agent questions
apps/server/src/materials   uploads, BlobStore, validation
apps/server/src/drafts      Yjs snapshot persistence, epochs
apps/server/src/runs        run records, assignment graph, reviews, apply
apps/server/src/events      durable events, broadcaster, pump
```

## Conventions that are load-bearing

All of these exist because breaking them caused a specific bug. Design §15.2 has
the full list; these are the ones you will hit first.

**Uniqueness rules live in the database.** Services translate a `23505` into the
right error code by constraint name. But **when a table has several unique
indexes, Postgres reports whichever it checks first** — the table constraint, not
a partial index added later. A handler naming the partial index compiles, reads
correctly, and never runs. Where the operation is find-or-create, match *any*
unique violation. Where outcomes must be distinguished, take the row lock first.

**Lock order is task → run → agent → budget.** Two paths taking the same two
rows in opposite orders deadlocks, and both read fine alone. This already
happened between B03 and C02.

**Returning from a transaction commits; throwing rolls back.** A handler that
repairs state and then raises discards the repair. Verify such a path by
asserting the repaired state, not the error — an assertion on the error alone
passes against a complete rollback.

**Anything written in both SQL and TypeScript needs a test comparing them.**
`schema.test.ts` reads live index predicates from `pg_indexes`.

**Concurrency tests need rounds, not one pass.** A one-round test passed a third
of the time against a path broken in every run.

**Mutation-check security tests.** Write the inverted assertion, watch it fail,
delete it. A redaction test here once passed against a shape the logger never
emitted.

## Verification standard

Nothing lands without:

```bash
npm run build && npm test
```

Then, for anything concurrent or security-relevant, the mutation check above.
Counts as of this handoff: **502 backend + 23 frontend**.

## Open questions

**Nobody has watched a browser receive a refresh hint.** The smoke test proves
the server's broadcast is *accepted* (202), and the `realtime` block is now
advertised to clients. The subscriber half is Role A's, and no one has yet
confirmed a hint arriving in a browser and triggering a refetch. Worth ten
minutes with two tabs open before the demo — the fallback is polling, so a
failure here is quiet rather than visible.

**Materials are text-only** (§3.4: reject binary). No PDFs or images. Deliberate
and flagged to the product owner; a demo where someone drags in a PDF will show
a validation error. Changing it is a design decision, not an implementation one.

**Workspace creation is rate-limited but otherwise open.** §9.4 explicitly
removes agent quotas, so a leaked link means unbounded model spend on the
project's API key. Deliberate. The data is there to add a guard if a demo goes
sideways.

**`workspaces.status`** (`active`/`archived`) has no route anywhere. Dead column.

## The one habit worth keeping

Every ticket here found at least one bug in its own code *after* it appeared to
work — a handler that never ran, a test that could not fail, a rollback that
undid the thing it was reporting. None were found by writing more code. They
were found by asking "would this test fail if the behaviour were wrong?" and
then checking, rather than assuming.

Do that, and write down what you find in `pitfalls.md`. It is the most useful
file in this repository.

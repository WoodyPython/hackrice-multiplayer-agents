# Pitfalls

Things that have actually gone wrong in this codebase, written as what happened
rather than as rules. The rules they produced live in design §15.2; this is the
evidence behind them.

Short on purpose. Add an entry when something costs you more than a few minutes
and would cost the next person the same.

---

## A corruption fixture could not overwrite Git's hidden file on Windows

**D02.** A test intentionally rewired one worktree's `.git` pointer to another.
Node's default `writeFile` open mode failed with `EPERM` because Git marks this
file hidden on Windows. The service had not run yet; this was fixture setup.
Replacing the same-length pointer with `r+` lets the fixture reach the intended
reciprocal-registration check. The runtime never rewrites that pointer.

---

## A constraint-name match that never matched

**B05, `draft_files`.** Find-or-create caught the unique violation by name and
named `draft_files_active_uq`, the partial index. Postgres reported
`draft_files_epoch_uq`, the constraint declared with the table — **18 times out
of 18**. The handler compiled, read correctly, and had never once run.

It surfaced as an intermittent 500 in roughly two runs in three, because whether
two inserts genuinely overlap is a timing accident.

**Why:** when several unique indexes on a table can be violated by one insert,
the database reports whichever it checks first, and that is the table
constraint, not a partial index added in a later migration.

**Instead:** where the operation is find-or-create, treat *any* unique violation
as "someone else got there first" and re-read — the specific index does not
change the response. Where outcomes must be distinguished, take the row lock
first. That is why `start()` can safely match `runs_active_uq` by name despite
`runs` having five unique indexes: the lock serialises the critical section, so
only one index is ever in contention. Verified, not assumed — 72 concurrent
starts across 12 tasks.

---

## A computed key defaulted instead of computed

**B05, same function.** Creating a document defaulted to epoch 1. That works
exactly once. After Apply closes an epoch, inserting epoch 1 again collides with
the closed row — and the active-document lookup filters closed rows out, so it
could not see the conflict to recover from it. **Every reopen after an Apply
failed.**

Deterministic, not a race, and the race fix could not have caught it: "someone
else got there first, re-read" is right for contention and useless when the
conflicting row is invisible to the lookup.

**Instead:** where a row's identity includes a number derived from existing
rows, derive it on every path. Find-or-create with a derived key is read,
derive, insert, re-read on conflict, in a bounded loop.

---

## A concurrency test that passed against broken code

The convergence test ran **one** round of four concurrent opens. Against a path
that was broken in every single run, it passed roughly a third of the time.

**Instead:** repeat the contended operation enough times that a regression fails
reliably. Twelve rounds, here.

---

## An error that looked like a disagreement

The same test folded responses into a `Set` and asserted its size was 1. A
failed request contributed `undefined`, so a 500 showed up as "two distinct
values" — reading exactly like a convergence bug, in the wrong place entirely.

**Instead:** assert every response succeeded *before* aggregating. The assertion
message should carry the body.

---

## A redaction rule that protected nothing

**B02.** The test asserted `[redacted]` appeared in the logs after an owner
request. It never did — Fastify's request serializer drops headers before pino
sees them, so the configured redact paths covered a shape the logger never
emits. The test could not have failed, and proved nothing.

**Instead:** drive the secret through the shapes it could plausibly be logged in
— a bare headers object, a context wrapper, by name in a body — and require each
to come back censored.

---

## A write endpoint is not the only way to expose a write

**B05.** Persisting a collaborative document snapshot looks like it wants an
HTTP route. It must not have one: an endpoint accepting a Yjs snapshot lets any
link holder replace a document wholesale, bypassing every update the room server
validated.

Design §11.4 already said browsers do not mutate storage directly. It was worth
writing down that this rules out a specific, convenient-looking endpoint.

**Instead:** in-process calls, with a test asserting the routes do not exist.

---

## Two definitions of one set, in two languages

`ACTIVE_RUN_STATUSES` was exported from the contracts package, commented "keep
in sync with 0003", and **never used** — three query sites hardcoded the list
instead. Four definitions of one set across SQL and TypeScript.

The duplication was not the danger; the invisibility was. A run status added to
the enum but missing from the active-run index would let two attempts run at
once, which is the single invariant the duplicate-Start guard rests on.

**Instead:** one definition in TypeScript, and a test that reads the live index
predicate out of `pg_indexes` and compares it to the constant in both
directions. SQL cannot import the constant, so the comparison is the only thing
standing between a rename and a silent hole.

---

## A type wrapper that quietly broke every consumer

**B01.** Timestamp columns were declared `Generated<Timestamp>`, nesting one
Kysely `ColumnType` inside another. `Selectable` cannot unwrap that, so a
selected `created_at` typed as the raw column rather than `Date`, and every
caller trying to format it failed to compile. Twenty-two columns.

`Timestamp` alone already makes a column optional on insert, so the wrapper was
both wrong and unnecessary.

**Instead:** when a generic wrapper is "obviously" needed, check what the type
actually resolves to before applying it twenty-two times.

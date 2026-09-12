# Pitfalls

## A WebSocket error handler erased the useful close code

**D03.** `ws` starts a protocol close with `1009` when a message exceeds
`maxPayload`. Unconditionally terminating the socket from its error handler
replaced that close with `1006`, hiding the reason from the client. The handler
now preserves a close already in progress. In the test provider, calling
`disconnect()` synchronously inside `connection-close` also reentered that
callback; setting `shouldConnect = false` stops retries without reentry.

Things that have actually gone wrong in this codebase, written as what happened
rather than as rules. The rules they produced live in design §15.2; this is the
evidence behind them.

Short on purpose. Add an entry when something costs you more than a few minutes
and would cost the next person the same.

## A fast response reopened a creation form before navigation finished

**A02, workspace creation.** Clearing the submitting flag in `finally` let a
double-click submit a second POST after the first response arrived but before
the route unmounted. Disabling only while a request was in flight did not cover
that gap. The creation interaction test caught two POSTs for one double-click.

The form now stays locked after success until navigation unmounts it. It unlocks
only after failure so an explicit retry remains available. The test exercises a
fast response and double-click, rather than only a deferred request.

---
## A pre-tool check did not guard queued Git publication

**C04.** D02 prepared and published a checkpoint under its workspace lock, but
an execution check made before calling it could expire while the operation was
queued or preparing its candidate. Checking the returned promise cannot undo
an already published ref. The additive guarded checkpoint capability now checks
the worker inside the Git lock at publication; tests invalidate timeout, run,
boot and local cancellation state after candidate preparation and verify that
the previous branch remains intact. Database receipts can still fail after Git
publication, so recovery uses saved Git history instead of replaying the batch.

## A parser cap was still a step-count cap

**C03, plan schema.** The shared schema described its 64-assignment ceiling as
a parser safeguard, but it still rejected otherwise valid plans by step count.
The assignment and dependency ceilings are removed; tests accept 101-node
plans and a join with 100 prerequisites. C02's token budget and fixed deadline
bound generation and repairs instead.

The permissive schema also defaulted missing dependency arrays, which could
silently drop a model's misspelled `depends_on`. Provider plans now use a strict
schema with required camelCase arrays before any graph checks or persistence.

## The intermittent suite failure is a Git test timing out

**Identified during B06.** A full-suite failure appeared roughly once in
seventeen runs and could not be reproduced. Forty runs of the database suites on
an isolated database found nothing, because it is not there.

It is `git-files.test.ts > commits create/replace/delete batches and keeps every
other branch isolated`, failing with `Test timed out in 30000ms` — not an
assertion. The Git suites do real filesystem and subprocess work, which on
Windows has a wide and unpredictable tail: handle release, antivirus scanning,
and process spawn all vary run to run.

`testTimeout: 30_000` lives in the shared `apps/server/vitest.config.ts`, so the
limit is a Role B setting applied to a Role D test. Raising it is one line and
would make the symptom go away. Worth a look first at whether a single test
needing tens of seconds is telling us something — a per-test timeout on the Git
suites is probably the honest fix rather than relaxing the bar for everything.

**The general lesson:** an intermittent failure with no assertion message is a
timeout until proven otherwise, and a timeout points at the slowest thing in the
suite rather than at whatever changed most recently.

---

## An expiry that rolled back, and opposite lock orders

**C02, question answers.** The answer path updated an expired question and then
threw inside its transaction, rolling the expiry back. It now returns the error
from the transaction and throws after commit. It also locked the question before
the task, opposite to deadline/cancel enforcement. Both paths now lock the task
first; concurrent expiry/answer tests exercise the boundary.

## Windows Git rejected its null config path

**C02 verification, D01 runtime.** Fourteen existing Git/runtime tests failed
with `COMMAND_FAILED`. The underlying error was `unable to access 'NUL': Invalid
argument` from Git's global configuration override. `/dev/null` works in Git for
Windows as well as Unix. Changing that path restored the existing tests.

---

## A throw inside a transaction rolled back the work it was reporting

**B03, answering an expired agent question.** The handler marked the question
expired, settled the task, and then threw `AGENT_TIMED_OUT` — all inside the
transaction callback. The throw rolled the transaction back, so the expiry it
had just written was discarded. Every call redid the work and undid it again,
and the self-healing this path was documented as providing never happened once.

The caller saw the right error, which is why it looked fine. Nothing asserted
that the row had actually changed. Found by Role C during C02, along with the
test that catches it.

**Why:** returning from a transaction callback commits; throwing rolls back.
Both are correct behaviours, and code that writes *and then* reports a failure
sits exactly on the seam.

**Instead:** return the error from the callback and throw it after the
transaction resolves. And when a handler's job is to repair state before
reporting a failure, assert the repair, not just the error — an assertion on the
thrown code alone passes against a complete rollback.

---

## Two paths took the same two locks in opposite orders

**B03 and C02.** Answering a question locked the question row and then the task.
Deadline enforcement and cancellation locked the task and then the question.
Under concurrency that is a deadlock, and it survived review on both sides
because each path is individually reasonable.

**Instead:** fix a global lock order and write it down. Here it is task, then
question, matching design §6.3's "a consistent lock order prevents deadlock:
workspace operation lock, then task document gate."

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

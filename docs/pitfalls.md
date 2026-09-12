# Pitfalls

## A review assessment cannot reuse the agent ledger's active-run gate

**C07.** The obvious way to run a fresh reviewer pass against a review's
candidate looked like another worker: create an `agent_instances` row, call
`PgAgentLedger.reserve`/`recordUsage` like everything else does. It cannot
work. Every one of those methods calls `isCurrent()`, which requires
`task.active_run_id === run.id` — correct for a worker, since that is exactly
the check that rejects a late result from a run that is no longer in charge.
But a review is assessed precisely when its run is *no longer* the active one
(it is terminal, or never existed for a manual-edit task), so that same check
would refuse every legitimate request. Weakening `isCurrent()` to admit this
case would also admit the late-result case it exists to reject.

The fix is not a smaller variant of the ledger; it is a separate, self-
contained accounting path (`ReviewAssessor`) that reserves and settles against
the same `task_agent_budgets` table under its own agent key, never touching
`agent_instances` at all. Recognizing "this shares the ledger's table but not
its lifecycle gate" earlier would have saved an initial pass that tried to
extend `createInstance` with an `allowTerminalRun` flag before backing out.

## A test that scripts an invalid plan runs until the token budget drains

**C06.** A planning test returning a plan that fails validation looked like the
obvious way to check that a run terminalizes. It is not: validation feedback
asks for a corrected plan, and the loop is bounded by the agent's budget and
ten-minute deadline, not by an attempt count. An adapter that always returns the
same invalid plan therefore spends 64,000 tokens at 100 per call before
anything fails — minutes of real database round-trips, then a 30-second test
timeout with no useful message. Script a *fatal* outcome instead (a blocked
response, unexpected tool calls) when the subject is run finalization. Keep
invalid-plan repair where it belongs, in the C03 planning tests.

## Settling a run and its task in two transactions strands one of them

**C06.** `PgRunStore.settle` ended the run and cleared `active_run_id` but left
the task status alone, so C06 had to write the task separately. Both orders are
broken. Run first: if the task write fails, the task reports `planning` with no
active run, which is precisely the stuck state section 2.2 warns about. Task
first: if the settle fails, the task is terminal while the active-run row still
exists, so Start is refused by the unique index and Cancel is refused because
the status is no longer cancelable — unstartable until a restart. `settle` now
takes the task status and writes both under the locks it already held.

## A completed worker is not necessarily integrated

**C05.** B07's ready-set query tests only prerequisite agent completion. C04
completes a worker before D05 merges its branch, so using that ready set directly
would start dependents on an older result head and release them even after a
merge conflict. C05 now requires a separate successful integration receipt,
records it with the new combined head, and keeps the worker checkpoint immutable.
Tests pause integration after both workers finish and verify the dependent still
has no base or running clock. Missing D05 support returns a visible pending state.

## A conflicted review cannot temporarily become ready

**D06 integration with B07.** The database requires a candidate SHA for every
review outside `building`, while B07's `markConflict()` only changes status.
Calling it directly on a newly created row violates `reviews_candidate_ck`.
Calling `markReady()` first would briefly expose unresolved content as ready.
D06 instead saves the provisional candidate and `conflict` status in one guarded
UPDATE. Clean candidate, task state, and `review.ready` event are also committed
in one transaction; an event failure rolls all readiness changes back.

## A deleted path can alias a retained path in candidate preview

**D06.** Resolving a case or file/directory collision can remove one source path
while retaining its counterpart. D02's worktree read deliberately rejects their
combined namespace. Preview reads immutable Git objects directly instead: an
absent source path returns null even when its counterpart remains in the tree.
The complete candidate tree still passes portable path validation.

## A temporary merge index still asked for a worktree

**D05.** Git 2.36 has no `merge-tree --write-tree`. The compatible merge path
uses `read-tree -m` and `merge-file`, but an alternate index alone did not make
`read-tree -m` work in the bare workspace repository. Adding `-i` explicitly
disables worktree checks. Conflict detection then uses the temporary index's
unmerged stages, while text merging works on server-allocated scratch files.

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

---

## An append cursor cannot see a field that changed in place

**A04, task discussion.** Discussion is paginated by `seq`, and the interface
notes say to poll with `?afterSeq=`. That is right for what it was designed for:
entries only ever get appended, so a refetch returns just the new ones and a
duplicate poll costs nothing.

Answering an agent question is not an append. §2.6 flips `question.status` from
`open` to `answered` **on the entry that is already below the cursor**. Polling
additively never returns that entry again, so the question kept rendering as
open with an answer box under it, forever, in a thread that had already been
answered.

**Instead:** a write this client performed re-reads the thread from zero and
merges by id; ordinary polling stays additive. The merge was already keyed by
id, so the fix was one flag, but only after noticing that "poll with afterSeq"
answers a narrower question than it looks like it answers.

**The general shape:** when an API gives you a cursor, check whether the
resource is append-only. If any field on an existing row can change, the cursor
is an optimisation for the common case and not a complete refresh strategy.

---

## A file-upload test that could not reach the code it was testing

**A04, material upload.** The guard that rejects a PNG before the request leaves
the browser had a test that passed for the wrong reason. `user.upload()` from
testing-library honours the input's `accept` attribute: given a `.png` against
`accept=".md,.txt,…"` it sets no file at all, so the change handler never ran,
no request was attempted, and the assertion "no POST was made" passed against
code that was never executed.

It surfaced only because the *other* assertion in the same test — that an error
is shown — failed. Had the test only asserted the negative, it would have been
green and meaningless.

**Why it matters beyond the test:** `accept` is a filter, not a guarantee. The
OS dialog has an "All files" option and a drag-and-drop bypasses `accept`
entirely, so the JavaScript guard is the real check and needs real coverage.

**Instead:** set `files` on the input directly and dispatch `change`, which is
what the browser does in the cases `accept` does not cover. And be suspicious of
a test whose only assertion is that something did *not* happen — that passes
just as well when nothing happened at all.

---

## Supabase Storage reports a missing object as 400, not 404

**B04/B06 verification, first live Supabase project.** `npm run supabase:smoke`
failed at the read-after-delete step with `storage read failed with 400`, two
lines after reporting a successful upload and an identical read back. Nothing
was wrong with the project, the bucket, or the key. Storage worked; the store
could not recognise an object that was absent.

Supabase Storage answers a GET for an object that is not there with **HTTP 400**,
and puts the status it means inside the body:

```json
{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}
```

`get` mapped only a real `404` to `null` and threw on everything else, so the
branch that makes `BlobStore.get` return `Uint8Array | null` had never once run
against the implementation that ships. `delete` had the same hole.

**Why it stayed invisible:** `LocalDiskBlobStore` implements the contract
correctly and is what every test injects, so the materials suite passed against
the wrong implementation. The Supabase path had no test at all, and the one
place its `null` is load-bearing — `readSelected` turning a missing object into
`MATERIAL_NOT_FOUND` rather than serving an empty file to a model — would have
become a 500 the first time an object actually went missing.

**The trap in the fix:** a missing *bucket* is also 400 and also claims
`"statusCode":"404"`; a rejected key is 400 claiming `"403"`. Mapping 400 to
`null` makes the smoke test pass and silently converts a mistyped
`SUPABASE_STORAGE_BUCKET` into "every material is missing" — a configuration
error no caller can tell apart from an empty store. The discriminator has to be
the body's `code` (`NoSuchKey` / `NoSuchBucket` / `AccessDenied`), not the status
it claims.

**Instead:** where a hosted API's status line disagrees with its body, believe
the body, and match the specific condition rather than the status class. And
when an interface returns `T | null`, check that *every* implementation can
actually produce the `null` — not just the one the tests use.

---

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

## Monaco 0.56 changed its package exports

**A03.** The historical `monaco-editor/esm/vs/...` import fails in the production
bundle with Monaco 0.56. Worker imports now use `monaco-editor/editor/...`.
`y-monaco` still uses the old editor API path, so Vite aliases that exact import
to the new export. Typechecking alone did not catch this; the Vite build did.

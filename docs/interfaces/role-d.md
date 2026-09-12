# For Role D — Git and live runtime against the data layer

**Reflects:** D08, B07, C02, C05, C06, C07, C08, plus the A06/A07 requests below · **Owner:** Role B (data), Role C (execution guard)

## D08 runtime recovery

Startup now calls `markInterruptedFromPreviousBoots()` before building the application and reconciles pending applies before attaching transport, opening orchestration, or listening. Existing saved snapshots and Git checkpoints restore on demand. No old execution is resumed; the existing explicit retry route creates a new attempt after interruption clears the active-run pointer.

`LocalReviewService.reconcilePreviousApplies()` shares D07's finalization transaction: main at the candidate completes metadata and closes epochs, main at the expected SHA retains pending owner/freshness checks, and any other SHA records ambiguity and blocks document writes. Storage failures abort startup. See [D08 recovery details](git.md#startup-recovery-d08). C08 retains ownership of saved-output selection and broader retry behavior; retry reads saved accepted commits as immutable references and never replays old tool calls. See [C08 notes](../../apps/server/src/orchestration/RETRY.md).

## C07 additions to `reviews/routes.ts`

`registerReviewRoutes(app, reviews, c07)` now takes a required third argument:
`{ evidence: ReviewEvidenceComposer, assessments: ReviewAssessmentService }`,
both constructed in `recovery/runtime.ts` alongside the rest of Role C's stack
and sharing its one `ModelAdapter`. Two additive routes follow D06's existing
shape — read the review through `reviews.read()` first, then hand its result
to the injected capability rather than touching Git:

- `GET .../reviews/:reviewId/evidence` → `ReviewEvidence`
- `POST .../reviews/:reviewId/assess` → `ReviewAssessment`, no body

Both read-only from D06's side: neither mutates a review row or its candidate.
`ReviewAssessmentError` is translated to a proper `ApiError`
(`REVIEW_NOT_FOUND`, `AGENT_TIMED_OUT`, `AGENT_TOKEN_EXHAUSTED`, or
`INVALID_STATE`) at the route, the one place a C07 error crosses HTTP
synchronously — everywhere else in this design, an agent outcome reaches the
browser through a durable event instead. See
[C07's notes](../../apps/server/src/orchestration/REVIEW.md) for why this
capability is not built on the run/agent-instance lifecycle at all.

## C06 changes inside the runtime

`startRuntime` now builds Role C's stack and passes the real `OrchestrationHook`
to `buildApp`, so Start executes. Three ordering constraints came with it:

- The `LiveDocumentCoordinator` is constructed **before** the application,
  because Start captures the human draft through that same singleton. A second
  coordinator for one runtime would capture a different set of rooms.
- Shutdown stops orchestration **first**, before sockets and the database, so an
  in-flight run's last writes are not aborted mid-transaction. Runs still active
  at exit stay for `markInterruptedFromPreviousBoots` to reconcile.
- `startRuntime` returns `orchestration` alongside `collaboration`. Its `open()`
  owns the agent deadline sweep; one process per data root owns it.

Material bytes reach workers through the same `defaultBlobStore(config)`
selection the application uses, now exported from `http/app.ts`. Without
`GEMINI_API_KEY` the process still boots and serves everything else; each Start
ends its run with `model_configuration` instead of hanging in `planning`.

## C05 integration handoff for D05

C05 now consumes `LocalGitService.integrateGuarded` through the shared
`GuardedResultIntegrationService` capability. D05 prepares under its workspace
Git lock and awaits `ResultIntegrationGuard`
before publishing the result ref. C05 records the combined head and receipt
under task/run/agent locks; completed worker checkpoints remain immutable.
Isolated callers lacking that capability use the pending-result recorder. See the
[exact contract and recovery boundary](../../apps/server/src/orchestration/SCHEDULER.md#d05-integration-seam).
Do not adapt the unguarded `GitService.integrate` by checking only after it returns.

## C02 guard for agent effects

Before accepting an agent's Git/checkpoint effect, hold the appropriate mutation
gate and call `PgAgentLedger.assertActive(agentInstanceId)`. A previous model
response is not permission to write: the instance may have expired, been
canceled, or belong to an old run/boot. Short database writes can instead use
`withActiveWrite` and its supplied transaction. See the
[C02 integration notes](../../apps/server/src/agents/README.md).

`AgentExecution.close()` aborts local work; `StartOrchestrator` owns scope
lifecycle and durable run finalization (C06). Late provider usage remains
recordable, but late results must not change accepted output. The Git runner now uses `/dev/null` for its empty
global config on Windows as well as Unix; this Git for Windows rejected `NUL`.

D01 already integrates correctly: `GitWorkspaceLifecycleHook` honours the
fire-and-forget contract, `ensureRepository` provides the self-healing path, and
`recovery/runtime.ts` wires the application factory as design §15.1 specifies.
What follows is for D02 onward.

D02's implemented Git surface and the D03/D04 checkpoint handoff are documented
in [Git files and checkpoints](git.md), reflecting D02. The B05 persistence
surface below remains unchanged.

---

## `PgDraftStore` — persistence for shared documents

You own the live in-memory document, the update protocol, and awareness. This
owns what survives a restart.

| Method | Contract |
|---|---|
| `resolveRoom({workspaceId, taskId, draftFileId})` | Call before attaching any socket. Validates the whole triple against the database; raises `DOCUMENT_EPOCH_CLOSED` for a closed document |
| `load(workspaceId, draftFileId)` | Metadata plus `yjsState` / `stateVector`, both null until seeded |
| `initialize(draftFileId, {yjsState, stateVector, baseBlobSha})` | Seeds once |
| `persist(draftFileId, {revision, yjsState, stateVector})` | Revision-guarded write |
| `closeEpoch(workspaceId, taskId)` | After Apply. Idempotent; returns the number of rows closed |
| `openForTask` / `openNextEpoch` | The same operation: the active document, creating the next epoch if none is active |
| `listActiveForTask` | For the editor's file selector |

---

## Three behaviours that are easy to get wrong

**`persist` returning `applied: false` is normal.** It means a newer revision
already covers those updates. The guard is `WHERE persisted_revision < $revision`
in the statement, not a read-then-write, because two saves can be in flight at
once and any check before the UPDATE is stale by the time it runs. Do not retry
on it and do not surface it as an error.

**`initialize` returning `initialized: false` means someone else won — load
what they stored, do not merge your copy in.** Design §7.2: "merging separately
initialized copies can duplicate content." Two rooms can reach initialization
simultaneously, and the whole point of the guard is that the loser adopts rather
than merges.

**The initial text comes from Git, which this layer cannot read.** You supply
both the encoded document and the blob SHA it was built from.

---

## Room resolution

`resolveRoom` is what makes design §12.1's "a caller cannot pass an arbitrary
room name that opens a filesystem path" true rather than aspirational. Every
element of the triple is checked against the database rather than trusted from
the room name, and route-level UUID validation runs before that.

Call it before attaching a socket, not after.

---

## Epochs are rows, not a counter

Closing an epoch leaves the old record intact, so a browser holding unsent edits
against it can still be told what happened rather than having its document
silently redefined (design §7.6). Reopening the path creates epoch N+1.

Creation derives the next number from every epoch that has existed for that
path. Defaulting to 1 works exactly once — see
[`pitfalls.md`](../pitfalls.md#a-computed-key-defaulted-instead-of-computed).

---

## No HTTP route writes a snapshot

`persist`, `initialize`, and `closeEpoch` are **in-process calls only**. Design
§11.4 keeps browsers out of storage, and an endpoint accepting a Yjs snapshot
would let any link holder replace a document wholesale, bypassing every update
you validated. Opening a draft is the only part of that surface a browser
reaches. There is a test asserting those routes do not exist; if you need one,
that is a design conversation, not a route to add.

---

## Reviews and apply

`PgReviewStore` holds the records; you build candidates and move the ref.

`create({source})` records the exact tuple a candidate was built from —
`ReviewSource` in `@app/contracts`: `(taskVersion, guidanceVersion, mainSha,
humanSha, resultSha, documentRevisions, contextHash)`. It starts in `building`,
because the schema permits a null candidate only in that state, so a review can
never reach an owner without one. `markReady(id, candidateSha)` attaches it.

**Call `invalidateForTask(taskId, reason)` on every accepted edit**, not on
every persisted one. Design §7.6: a new edit marks a review stale immediately,
before the debounce has written anything. Applied reviews are deliberately
untouched — a record of what was published must not be rewritten by later
typing.

**The apply sequence is three steps, and the order is the whole point:**

1. `claimForApply(reviewId, candidateSha)` — guarded on `status = ready` *and*
   on the candidate matching, so a browser looking at an earlier candidate
   cannot apply a refreshed one it never saw, and two simultaneous applies
   resolve to one winner.
   The implemented method is a guarded read, not an exclusive claim: D07 holds
   the workspace lock across publication and relies on `begin`'s unique operation
   row for durable duplicate protection. Do not use `claimForApply` alone as a lock.
2. `begin({...})` writes the pending record **before** the ref moves. Git and
   Postgres do not share a transaction (§10.5), so this row is the only evidence
   an apply was in flight if the process dies mid-way. One row per review,
   enforced; a second call returns the existing one rather than creating a rival
   record, because two records would make reconciliation ambiguous — exactly the
   state §10.5 says to stop on.
3. `settle(reviewId, status)` after the ref update, then `markApplied`.

**On startup**, `pendingFromPreviousBoots(bootId)` returns operations stranded
by a dead process. Reconcile each against main per §10.5: the candidate already
on main means it succeeded, main still at the expected value means it never ran,
anything else is ambiguous and stops.

## The Git suites now dominate a full run

`git-integration.test.ts` takes **over nine minutes in isolation** and around
seventeen inside a full run, and its
`preserves refs and guard errors when cancellation rejects prepared
fast-forward, merge, or no-op results` burned 487 seconds before failing.
`vitest.config.ts` still says "The whole run is a few seconds."

The practical cost is not the wait: it is that a full suite priced at a quarter
of an hour is one people stop running before pushing, which is the habit that
broke `main` once already. These suites do real filesystem and process work per
test and appear not to share fixtures.

Recorded in [pitfalls](../pitfalls.md). Raising timeouts is the one fix worth
avoiding — it converts a visible cost into an invisible one.

---

## What Role A needs from you (A06, A07)

Two things, in priority order.

**D07's apply path, which three screens wait on.** It is unblocked now — D06 has
landed and B02 was always there — and it is the single highest-leverage ticket
left: it unblocks A06's Changes tab, it is half of what B08 needs (C07 is the
other half, also unblocked, and the two are independent), and it is what first
writes `apply_operations`, which is the entire content of the History screen.
`applyReviewRequestSchema` and `applyReviewResponseSchema` are already in
`@app/contracts` with nothing behind them.

Also needed for A06: some way for the browser to **discover a task's review
without mutating anything**. Today the only path to a review ID is
`POST /tasks/:t/review`, which prepares a candidate — a page cannot call that on
load. A `reviewId` on `TaskDetail` would do; that part is Role B's.

**A `GitService` wrapper over the tree listing you already have.** This is
smaller than it was when first written here. `ManagedWorktrees.tree(sha)`
already enumerates a commit as path → blob for review building; what is missing
is only a `GitService` method exposing it, since `GitService` offers
`readText(path)` for one known path and nothing that lists.

Without it nothing the API can call will say what is on the approved branch,
which blocks the Files screen's approved section (§4.1) and the approved-file
category in the task input picker (§2.1). Both currently say the data is
unavailable rather than showing an empty list, because "no approved files" is a
claim we cannot support.

A path list at a commit is enough — content comes from `readText` per file as it
is opened. Role B adds the route once the method exists.

---

## Startup reconciliation (landed in D08)

`PgRunStore.markInterruptedFromPreviousBoots()` is now called from
`recovery/runtime.ts` **before** the server accepts task actions, per
§14.4 step 2. It marks stale runs and instances interrupted, clears the affected
tasks' active-run pointers, and resolves their open questions.

Clearing the pointer is not cosmetic: the unique active-run rule would otherwise
leave every interrupted task permanently unstartable after a restart, and a task
would sit in `needs_input` with nothing left to answer.

`CollaborationService.isCurrent` must still check in-memory dirty state, not
only the persisted row (§7.6).

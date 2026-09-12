# For Role D — Git and live runtime against the data layer

**Reflects:** B07, C02, C05, C06 · **Owner:** Role B (data), Role C (execution guard)

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

## Startup reconciliation

`PgRunStore.markInterruptedFromPreviousBoots()` fills the placeholder in
`recovery/runtime.ts`. Call it **before** the server accepts task actions, per
§14.4 step 2. It marks stale runs and instances interrupted, clears the affected
tasks' active-run pointers, and resolves their open questions.

Clearing the pointer is not cosmetic: the unique active-run rule would otherwise
leave every interrupted task permanently unstartable after a restart, and a task
would sit in `needs_input` with nothing left to answer.

`CollaborationService.isCurrent` must still check in-memory dirty state, not
only the persisted row (§7.6).

# C06: explicit Start and captured context

`StartOrchestrator` implements `OrchestrationHook` from `@app/contracts`. B03
creates the run row inside the Start transaction and calls it after commit, with
the HTTP response already sent. It performs design section 2.2 steps 4 onward:
capture, plan, dispatch, and terminalize.

```ts
const orchestration = new StartOrchestrator({
  db, bootId, ledger, adapter, git, materials, drafts, collaboration,
  planner,            // C03 OrchestratorPlanner
  scheduler,          // C05 ParallelAssignmentScheduler
  onBackgroundError,  // nothing here has a caller to raise to
});
orchestration.open();                       // starts the deadline sweep
const app = await buildApp({ db, config, lifecycle, orchestration });
await orchestration.close();                // on shutdown, before the database
```

The runtime already wires this; do not construct a second one against the same
data root. `open()` owns the periodic `sweepDeadlines()` for agents whose fixed
deadline passes while they wait on a human (section 9.2). `close()` stops the
sweep, aborts local planner/scheduler scopes, and waits for in-flight attempts;
runs still active at exit are marked interrupted at the next startup.

## What capture freezes

Nothing downstream re-reads live task text. C03 validates the captured context
against the run row, and C04 binds worker tools to the stored manifest, so a
missing input here is missing for the whole run.

- **Materials are the union of two sources.** Explicitly selected
  `task_input_links` rows *and* materials attached directly to the task
  (section 3.3: "selected by default" is not a stored row). Reading only the
  first silently drops every attachment.
- **Discussion stops at the cutoff.** Entries at or below
  `runs.discussion_cutoff_seq`, which B03 fixed at creation. An entry posted
  after Start never enters any agent's context for that run, including
  assignments that have not started.
- **Approved files** are read from the exact `mainSha` recorded as
  `approvedCommitSha`.
- **Drafts** are every active document of the task, read from the D04 checkpoint
  that capture just made, with their exact Git blob hashes.
- **Selections that cannot be captured are reported, never invented.** A deleted
  material, a selected path absent from main, a draft belonging to another task,
  or an unusable path is listed in the capture event's `omitted` array rather
  than captured as empty text, which would reach a model as evidence.

The capture event is `agent.waiting` with key `run:<runId>:start:context_captured`
and payload `{ phase: 'start', reason, inputSnapshotSha, draftCheckpointSha,
materials, sources, discussionCutoffSeq, omitted? }`. It carries counts and
identifiers only: no file text, no provider text, no filesystem locations.

## The start snapshot (section 8.4)

Capture combines approved main (A) with the human draft checkpoint (L) through
`LocalGitService.combineStartSnapshot`, and records the result as
`runs.input_snapshot_sha`. The common case is a fast-forward: the draft branch
already descends from main, so the checkpoint *is* the snapshot. When main has
moved independently, a three-way merge produces a snapshot commit with both as
parents. Neither main nor the human draft is written, and no branch is
published — C05 creates the result branch at this commit.

A conflicting combination ends the run **before any model call**: run
`incomplete`, task `conflict`, event reason `snapshot_conflict` with the
conflicting paths. No planning instance is created, so no budget is spent on a
start that cannot proceed.

## Terminal states

The run always ends. A run stuck in `planning` is worse than a failed one,
because nothing in the UI recovers from it.

| Outcome | Run | Task | Reason |
|---|---|---|---|
| Every assignment integrated | `completed` | `ready_for_review` | `assignments_integrated` |
| Any integration conflict | `incomplete` | `conflict` | `integration_conflict` (with `paths`) |
| Any failed, blocked, or pending integration | `incomplete` | `incomplete` | `assignments_incomplete` |
| Canceled during scheduling | `canceled` | `canceled` | `canceled` |
| Capture, planning, or dispatch failed | `incomplete` | `incomplete` | a stable code |

Failure reasons are stable codes (`snapshot_conflict`, `task_version_changed`,
`planning_blocked_response`, `agent_timed_out`, `model_configuration`, …), never
a message. Section 13.3 keeps provider text, credentials and internal paths out
of anything a contributor or a later model can read, and a task event is both.

Run and task settle in **one** transaction, through
`PgRunStore.settle(runId, status, reason, taskStatus)`. Two transactions cannot
do this safely: ending the run first leaves the task reporting `planning` with
nothing behind it, and ending the task first leaves it terminal while the
active-run row still blocks every retry.

## What C06 does not do

It never throws into the Start caller, never creates the run row, and never owns
the duplicate-start guard — that is the row itself, plus B03's idempotency key.
It does not re-trigger on a replay, because B03 suppresses the hook for one.
Before any write it checks `boot_id`: a run from a previous process was already
marked interrupted at startup, and resurrecting it is exactly the late write
section 14.4 forbids. Such a run is left completely untouched.

Cancellation is durable in B03's transaction before the hook is called;
`onCancelRequested` stops the local planner and scheduler scopes and sweeps
deadlines. Review preparation and the request-revision handoff are C07. Manual
retry is implemented in [C08](./RETRY.md); startup reconciliation remains D08.

## Verification

`npm run test:start --workspace @app/server` uses real PostgreSQL and a real
repository, with only the provider scripted. It covers the captured union of
selected and attached materials, the discussion cutoff, approved and draft
sources, a clean divergence combined into one snapshot the result branch starts
at, a conflicting divergence rejected before any model call, a task revised
between the Start transaction and capture, a fatal planning failure, a
previous-boot run left untouched, hook redelivery, and cancel.
Run `npm run build` and `npm test` for repository-wide checks. No API key,
migration, or new dependency is required.

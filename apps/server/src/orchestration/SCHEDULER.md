# C05: parallel assignment scheduling

`ParallelAssignmentScheduler` consumes a completed C03 planning instance and
the same captured `PlanningContext`. It revalidates the saved artifact and
capture digest, creates stable worker keys through `PgAgentLedger`, persists
every dependency, initializes the result branch at the input snapshot, and
dispatches independent workers through C04's `WorkerExecutor`.

```ts
const scheduler = new ParallelAssignmentScheduler({
  db, bootId: config.bootId, ledger, adapter, workers, git,
  // LocalGitService supplies guarded D05 integration automatically.
  // integration: an optional WorkerResultIntegrationService override for tests
});
const result = await scheduler.schedule({ runId, planningInstanceId, context });
```

Use one scheduler/executor per runtime. Identical concurrent schedule calls
coalesce. A durable per-run claim rejects another scheduler or a subsequent
replay, including after partial setup. This is deliberately not workflow
recovery; C06 must catch setup/stale-run errors and finalize the run, and C08/D08
own manual retry/recovery. No HTTP hook is wired here. Posting stays inert.

## Eligibility and persistence

There is no task/worker count cap or whole-wave barrier: a dependent starts as
soon as all its own prerequisites have integrated, even while unrelated
workers are still executing. Workspace queues serialize result initialization,
base selection/worktree creation and integration only. Model calls and human
waits run outside those queues.

`PgRunStore.readyInstances` considers completion only. C05 additionally requires
successful integration receipts before assigning a base or dispatching. The
base is the current `runs.result_head_sha`, persisted before creating a writer
or coder's D02 worktree. Analyst/reviewer workers need no worktree. Pending
prerequisites have no base, start time or deadline. C04 starts the execution
clock when its execution scope opens.

An assignment outcome is `integrated`, `conflict`, `pending_integration`,
`failed`, `blocked`, or `canceled`. These are scheduler outcomes, not additions
to the database agent-status enum. A worker may be completed with integration
still pending or conflicted. The receipt retains that distinction without
mutating a terminal worker's checkpoint SHA. Its dependents remain pending,
with a durable blocked event. Independent peers continue after a failure or
conflict. C06/C07 derive the final run/review state after these outcomes settle;
they also settle any still-pending instances. Scheduling does not apply main.

## D05 integration seam

`LocalGitService.integrateGuarded` implements `GuardedResultIntegrationService`
from `@app/contracts` and is selected automatically by the scheduler. An explicit
`WorkerResultIntegrationService` can override it for isolated tests. The old
unguarded `GitService.integrate` is insufficient for queued publication.
The input includes server-derived scope, worker base/result and expected
combined head. D05 validates these exact Git sources and the complete changed
path scope, prepares its existing three-way merge under the workspace Git lock,
then awaits the supplied guard immediately before publishing.
The guard takes task/run/agent locks, checks current boot, active-run identity,
completed worker result and expected result head, then invokes `publish` and
records the new head/receipt. No DB transaction surrounds Git preparation.

Return `handled` only after the guard resolves. A conflict calls the guard with
`{ status: 'conflict', paths }`; it never invokes the publication callback or
advances the result head. Do not write main or the human draft. A completed
worker's execution deadline does not invalidate a result already accepted by
C04, but canceling/superseding its run prevents subsequent integration.

When an isolated caller supplies neither the guarded Git capability nor an
explicit integration service, `NullWorkerResultIntegrationService` records
calls and returns `unavailable`. Changed results then remain visibly
`pending_integration` and never release dependents. Production LocalGitService
uses D05. Readonly and unchanged workers receive a successful receipt against
the current head without needing a merge. The suite runs real parallel C04
checkpoints through D05 and verifies a dependent reads both merged outputs.

The guard runs for no-op results and conflicts too. Cancellation is rechecked
after database lock waits and immediately before publication. D05's legacy
unguarded method remains available to its existing backend callers/tests.

Git/DB publication is not a distributed transaction. Failure after Git ref
publication may leave Git ahead of its DB receipt. The scheduler reports
failure and does not retry or unlock downstream work. Recovery must inspect
the retained Git history; do not silently rebase or repeat the operation.

## Events and provider waiting

- `agent.checkpointed`, `phase: 'integration'`, `status: 'integrated'`,
  `agentId`, `resultSha`: durable successful receipt.
- `agent.waiting`, `phase: 'integration'`, `status: 'conflict'`, `paths`:
  conflicting assignment files.
- `agent.waiting`, `phase: 'scheduler'`, `reason`: failed, blocked, or
  pending-integration outcome. The per-run setup event has reason
  `preparing_assignments`.
- `agent.waiting`, `reason: 'provider_backoff'`, `agentId`, `waiting`,
  `delayMs`, `retryAt`: C04 provider retry starts/resumes. Keys include the
  counted model request ID and phase; payloads omit provider exception text.

Provider waits retain C02's budget/deadline and exponential 1–30 second delay.
They do not create a question or set `needs_input`. On terminalization, the
agent's terminal status supersedes its last waiting event; a canceled wait
does not emit a misleading resumed event. These durable events are available
to B06 refresh and later A05 progress integration; no new frontend is added.

`cancel(runId)` aborts local scheduling and active workers, including an
integration publication guard. C06 must also persist task/run cancellation
and invoke deadline sweeps; local cancellation alone is not durable recovery.

## Verification

`npm run test:scheduler --workspace @app/server` uses real PostgreSQL and
scripted worker/integration outcomes plus real WorkerExecutor/D05 handoffs.
`npm run test:git --workspace @app/server` covers D05 guard rejection, source
and scope checks, conflicts, and preservation of main/human/worker refs.
`npm run test:workers --workspace @app/server` verifies provider waiting events.
Run `npm run build` and `npm test` for repository-wide checks. No API key,
migration, or new dependency is required.

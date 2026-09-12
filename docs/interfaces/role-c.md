# For Role C — orchestration against the data layer

**Reflects:** B07, C02, C03, C04, C05 · **Owner:** Role B (data), Role C (execution)

> **Resolved: `PgAgentLedger` is the ledger.** B07 briefly shipped a second one,
> `PgBudgetLedger` under `src/runs`; it has been deleted. Yours won on three
> counts: §15.1 assigns `src/agents` to Role C, your `reserve` derives the
> output allowance from the remaining budget as §9.3 step 3 actually requires
> (mine took a caller-supplied number), and you own the deadline sweep. There is
> now one writer to `task_agent_budgets` and one path that creates an instance.


## C02 execution and accounting

C04's `WorkerExecutor` now wraps the five worker tools in this execution scope.
C05 now persists each worker's base, creates mutating worktrees, and dispatches
after prerequisites have successful integration receipts. C06 supplies the immutable captured context and
owns cancellation/run finalization. Read the [C04 integration notes](../../apps/server/src/workers/README.md).
`agent.completed` worker events contain `{ agentId, result }`; result holds the
summary, issued references, limitations, verified artifact hashes and result SHA.
`agent.checkpointed` records accepted Git checkpoints. No migration is needed.

`ParallelAssignmentScheduler.schedule({ runId, planningInstanceId, context })`
loads the durable C03 plan and returns assignment outcomes plus the combined
result SHA. Use one scheduler per process, catch setup errors, and finalize
runs in C06/C07. Completed worker status alone is not integration readiness.
The runtime's `LocalGitService.integrateGuarded` is selected automatically for
D05 merging. Only isolated callers without that capability fall back to the
recorder returning `unavailable`. See [C05 integration notes](../../apps/server/src/orchestration/SCHEDULER.md).

`PgAgentLedger` and `AgentExecution` are available under `src/agents`; their
[integration notes](../../apps/server/src/agents/README.md) describe the callable
surface and transaction boundaries.

Create each instance with a stable task-scoped agent key and the model ID from
`adapter.getModel(preset)`. Open its execution scope only once prerequisites
finish. Reuse that scope for model calls, retries, tools, backoff, and human
waits. Manual attempts create new instances but preserve the budget key.

C06 must close scopes on completion/cancel/shutdown, sweep persisted deadlines,
and finalize the run after peer agents settle. C02 marks failed required output
incomplete without prematurely ending other agents. The current HTTP hook
remains a null implementation until C06 lands.

For database effects, use `ledger.withActiveWrite` with its supplied transaction.
Do not nest another service transaction inside that callback. Provider usage
may settle after timeout, cancellation, or restart; it never authorizes a late
result. Question answers now take the task lock before the question lock and
commit an expired question before returning its error.

---

## The context manifest

**Union two sources, or every attachment is silently dropped from every run.**

Design §3.3 says direct task attachments are selected by default, and "selected
by default" is not a stored row:

```
explicit selected inputs   (GET /tasks/:t  →  inputs[])
  ∪  task-attached materials (GET /tasks/:t/materials)
```

Reading only `task_input_links` misses every material someone attached. Writing
a selection row at attach time is the tempting alternative and is wrong: a later
wholesale replacement of the inputs would drop it just as silently, and nothing
would report either failure.

---

## `OrchestrationHook.onRunCreated` — your entry point

B03 creates the run row inside the Start transaction and calls you **after
commit**. The run arrives with `task_version`, `guidance_version`,
`discussion_cutoff_seq`, and `boot_id` already fixed. You fill
`input_snapshot_sha` and `context_manifest` after capture.

Three obligations:

**Never throw back into the caller.** The HTTP response was already sent. On
failure, end the run in a terminal state with a task event explaining why — a
run stuck in `planning` forever is worse than a failed one, because nothing in
the UI can recover from it.

**Check `boot_id` before any write.** A run from a previous boot is interrupted,
and its late results must be rejected (design §14.4).

**Do not re-trigger on a replay.** B03 already suppresses the hook for an
idempotent replay, so if you see a run, it is genuinely new.

---

## The discussion cutoff is absolute

Entries above `discussion_cutoff_seq` never enter any agent's context for that
run, including assignments that have not started yet. Design §2.3 made this
explicit precisely so no assignment reads a different discussion than the one
its plan was built from.

The one exception: an answer to a question the run itself asked reaches the
waiting agent through its question record, not through discussion context.

---

## Agent questions

First-class records, not formatted comments (design §2.6). `ask()` writes an
`agent_questions` row and renders it as a discussion entry.

- **One open question per agent instance.** Enforced by a partial unique index;
  a second `ask()` raises rather than queueing.
- **A question expires at its agent's existing deadline.** Asking never extends
  it. Waiting for a human consumes that clock (design §9.2).
- **We both resolve expired questions.** Your deadline sweep does, and so does
  the answer path — it treats `expires_at` as authoritative and returns
  `AGENT_TIMED_OUT` rather than recording an answer no agent will ever read.
  Both are idempotent so they cannot corrupt each other, but do not write code
  assuming you are the only writer.
- **`needs_input` is derived, not set.** A task reports it while its active run
  has an open question and leaves when none remain. Do not set task status
  directly for this.

---

## Budgets

`task_agent_budgets` is keyed by `(task_id, agent_key)` and **is never reset** —
not by retry, not by a new attempt, not by a model change. An exhausted budget
stays exhausted (design §14.3). Creating a retry instance reuses the row.

The table deliberately has **no** `consumed + reserved <= budget` check. Design
§9.2 records late usage after a deadline abort, and §9.3 reconciles against
provider-reported totals, either of which can legitimately overshoot a
reservation. Enforcement belongs before the call, not in a constraint that would
make honest reconciliation fail.

Usage can legitimately exceed a reservation — late usage after a deadline abort,
or a provider total above the estimate — and the budget row deliberately has no
constraint that would make that fail.

## What the data layer provides alongside your ledger

`PgRunStore` in `src/runs` holds the run, not the agent. No overlap with
`PgAgentLedger`.

- `linkDependencies(runId, plan)` — writes the dependency edges once your
  `createInstance` calls have made the instances. Re-checks acyclicity: you
  validate first in C03 where you can ask the model for a correction, and this
  second check exists because a stored cycle produces a scheduler that waits
  forever on prerequisites that can never complete. Idempotent.
- `readyInstances(runId)` — assignments whose prerequisites have all completed.
  Your parallel dispatch set (§8.7).
- `recordCapture(runId, {inputSnapshotSha, contextManifest})` — after C06's
  capture. Refuses a run from a previous boot.
- `settle(runId, status, reason)` — terminal run status, clears the task's
  active-run pointer, resolves open questions. Idempotent.
- `markInterruptedFromPreviousBoots()` — Role D calls this at startup.

**The database also refuses late writes from terminal instances.** Migration
`0006` adds a trigger rejecting a transition out of a terminal status and any
change to `result_sha`, `base_sha`, `write_paths`, or `deadline_at`. Recording
late usage stays permitted, per §9.2. You will see a `check_violation` naming
`agent_instances_terminal_no_write` or `agent_instances_terminal_no_transition`
— treat both as "this agent is done", not as something to work around. It backs
up your own `assertActive` rather than replacing it: the trigger catches a write
that reached the database through some path that forgot to ask.


---

## Plan validation

`OrchestratorPlanner` implements the new `OrchestratorPlanningService` seam in
`@app/contracts`. C06 supplies the existing planning instance and frozen
`PlanningContext`; C03 does not read current task text or capture live documents.
See [C03 integration notes](../../apps/server/src/orchestration/README.md).

`orchestratorPlanSchema` rejects misspelled/unknown fields. `validatePlan` checks
unique IDs, known presets, dependencies, cycles, read-only analyst/reviewer
scopes, safe exact paths, and transitive ordering of shared-file writers.
Neither assignments nor dependencies have a fixed count limit. Repairs and
provider retries retain C02's original budget and fixed deadline.

The validated plan, context digest and input snapshot SHA are stored in the
planning instance's `agent.completed` event in the same guarded transaction that
completes the instance. C05/C06 must revalidate the artifact and instantiate the
pending worker graph before dispatch. C06 still owns the outer
`AgentService.plan({ runId, manifest })` integration and run finalization.

The B07 handoff is tested: create instances through `PgAgentLedger`, call
`PgRunStore.linkDependencies`, then consult `readyInstances`. Linking must finish
before any worker scope opens. No second budget ledger is used by C03.

Fatal planning failures emit the additive `agent.failed` event. C03 stores the
agent failure and marks the task incomplete; C06 must terminalize the run and
clear `active_run_id`. Local `cancel()` must accompany durable task cancellation.

---

## Guarantees you can rely on

Materials reach you **pre-validated**: UTF-8, under 1 MiB, no NUL bytes, a
supported text extension. No defensive decoding needed.

Task IDs, workspace IDs, and document IDs are validated as UUIDs at every route
boundary before anything else runs.

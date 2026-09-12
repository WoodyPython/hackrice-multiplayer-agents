# For Role C — orchestration against the data layer

**Reflects:** B07, C02 · **Owner:** Role B (data), Role C (execution)

> **Unresolved: two ledgers now exist.** C02 shipped `PgAgentLedger` under
> `src/agents` while B07 was in flight, and B07 shipped `PgBudgetLedger` under
> `src/runs`. Both reserve and reconcile against `task_agent_budgets`. They do
> not corrupt each other — the atomicity is in the SQL, not in either class —
> but two writers to one ledger is a bug waiting to happen, and the duplication
> should collapse to one before C04 builds on either. Roles B and C to decide
> which survives.

## C02 execution and accounting

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

The ledger is `PgBudgetLedger`, and the sequence per model request is:

1. `ensure(workspaceId, taskId, agentKey)` once per logical agent.
   Create-if-absent, never reset.
2. `reserve({agentInstanceId, requestKey, tokens, modelId})` before the call.
   Returns `remainingTokens` — derive your output and thinking allowance from
   it. Raises `AGENT_TOKEN_EXHAUSTED` when too little is left; that is a stop,
   not a retry.
3. `reconcile({agentInstanceId, requestKey, usage})` after it returns.
4. `abandon({agentInstanceId, requestKey})` when the call failed without usable
   usage.

Three things that are easy to get wrong:

- **`reserve` is idempotent on `requestKey`.** A replay returns
  `reserved: false` and does not double-hold. Use a stable key per logical
  request.
- **`abandon` charges the reservation, it does not refund it.** Design §9.3 is
  explicit. Refunding would let an agent that keeps failing burn unbounded
  provider capacity while its recorded usage stayed at zero.
- **Never sum a reported total with its components.** `billableTokens` handles
  this; if you compute usage yourself, a reported `totalTokens` wins outright
  and components are summed only in its absence. Summing both roughly doubles
  every charge.

Usage can legitimately exceed a reservation — late usage after a deadline abort,
or a provider total above the estimate — and the budget row deliberately has no
constraint that would make that fail.

## Instances and the deadline

`PgRunStore` materialises a validated plan and manages instance lifecycle.

- `createInstancesFromPlan` writes instances and dependency edges in one
  transaction, and re-checks acyclicity. You validate first (C03), because you
  can ask the model for a correction; this second check exists because a stored
  cycle produces a scheduler that waits forever on prerequisites that can never
  complete, which is far harder to diagnose than a rejected plan.
- `start(agentInstanceId, AGENT_TIMEOUT_MS)` **derives** the deadline. You
  cannot supply one, and a second call returns the existing deadline rather than
  restarting the clock — §9.2: replanning and retries do not reset it.
- `assertWritable(agentInstanceId)` before any file write or checkpoint. Checks
  terminal status, boot identity, and the clock, all three.
- `readyInstances(runId)` returns assignments whose prerequisites have all
  completed. That is your parallel dispatch set.

**The database refuses late writes from terminal instances.** A trigger rejects
a transition out of a terminal status, and any change to `result_sha`,
`base_sha`, `write_paths`, or `deadline_at`. Recording late usage is still
permitted, per §9.2. You will see a `check_violation` naming
`agent_instances_terminal_no_write` or `agent_instances_terminal_no_transition`
— treat both as "this agent is done", not as a bug to work around.

---

## Plan validation

`agentPlanSchema` in `@app/contracts` parses model output. Zod covers shape
only. The remaining design §8.3 checks are graph properties it cannot express
and must run before dispatch:

- dependency IDs exist
- the graph is acyclic
- reviewer and analyst assignments declare no write paths
- assignments with overlapping write scopes have an ordering between them

The `max(64)` on assignments is a parser bound against a runaway generation, not
a product limit — design §9.4 explicitly rejects a fixed step count.

---

## Guarantees you can rely on

Materials reach you **pre-validated**: UTF-8, under 1 MiB, no NUL bytes, a
supported text extension. No defensive decoding needed.

Task IDs, workspace IDs, and document IDs are validated as UUIDs at every route
boundary before anything else runs.

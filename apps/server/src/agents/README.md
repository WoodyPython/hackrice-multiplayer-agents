# C02: task-agent budgets and execution deadlines

`PgAgentLedger` uses the existing PostgreSQL tables; no migration is required.
It implements the `recordUsage` and `enforceDeadline` parts of `AgentService`.
`AgentExecution` wraps the C01 adapter with counting, reservations, cancellation,
and rejection of late responses. Import both from `agents/index.ts`.

## Coordinator integration

```ts
const ledger = new PgAgentLedger({ db, bootId: config.bootId });
const profile = adapter.getModel('writer');
const agent = await ledger.createInstance({
  runId,
  agentKey: assignment.id,       // same logical key on every manual attempt
  assignmentKey: assignment.id,
  preset: 'writer',
  modelId: profile.modelId,
  instruction: assignment.instruction,
  writePaths: assignment.writePaths,
});

// Persist the validated dependency graph before opening an execution scope.
// Pending assignments have no deadline; start refuses unfinished prerequisites.
const execution = await AgentExecution.open({
  ledger, adapter, agentInstanceId: agent.id,
  onBackgroundError: () => logger.error('Agent accounting persistence failed'),
});
try {
  const response = await execution.generate(crypto.randomUUID(), request, {
    maxOutputTokens: 4096, // optional per-request ceiling, includes thinking
  });
  // C03/C04 validate response shape and tool permissions before using it.
  await ledger.withActiveWrite(agent.id, async (trx) => {
    // Short database checkpoint/result update using this same transaction.
  });
} finally {
  execution.close();
}
```

B07's `PgRunStore` now supplies run metadata, dependency linking and ready-set
reads. `PgAgentLedger` remains the sole budget/instance lifecycle surface after
the B07 consolidation. C06 now supplies the real `OrchestrationHook`, so Start
creates the planning instance and dispatches through this module; see the
[C06 integration notes](../orchestration/START.md).
The coordinator must retain each scope across its entire tool loop, including
`execution.run(signal => ...)` for tool work, backoff, and human-answer waits.
It must call `close()` on completion, cancellation, and shutdown, and periodically
call `ledger.sweepDeadlines()` to catch expired persisted instances without a
local scope. Scope timers enforce idle/human-wait deadlines while scopes live.

`close()` aborts local work; the task service/coordinator owns durable cancellation
and completion. `drain()` can observe eventual settlement, but must not block
shutdown forever if a provider ignores abort. The background error callback
must log safely and must not throw. Database failures must be monitored: an
unsettled reservation remains held until usage can be reconciled.

## Accounting guarantees

- Budgets are keyed by `(task_id, agent_key)`. Creating an instance inserts a
  64,000-token budget only if it is missing. Manual attempts and model switches
  retain consumed tokens and outstanding reservations.
- Counting and generation receive identical private snapshots, including the
  system instruction, tools, schema, tool history, and provider state.
- The adapter exposes its model ID and verified combined output bounds. The
  ledger checks them against the instance's model and derives an allowance from
  `budget - consumed - reserved - exact input`. Insufficient allowance records
  `token_exhausted` before returning an error; no generation starts.
- Every generation needs a distinct request key. Reusing a key is rejected,
  including after settlement. Automatic retries call `generate` again with a
  new key and the same instance, budget, and deadline. There is no retry quota.
- Reservations and reconciliation hold database row locks. Multiple service
  objects and concurrent calls cannot independently spend the same balance.
- Reported totals settle a call once. Thinking and cached input are not added
  on top of the provider total. Missing totals retain the full reservation as
  unknown; later known usage can settle it. Late usage may exceed the budget.
- A reservation is released with a zero total only if generation provably never
  started. Once generation is invoked, absent usage is treated as unknown.
- Reconciliation is allowed for previous boots, canceled runs and old attempts.
  Accounting never grants permission to accept their results.

## Deadline and write boundary

The first execution activity sets `started_at` and `deadline_at = started_at +
600 seconds`. Reopening or retrying the same instance reads those timestamps.
Only a new manual-attempt instance gets a fresh clock. Neither limit comes from
environment variables or frontend settings.

The timer aborts the local signal and persists timeout. The caller stops waiting
even if the provider ignores abort; an eventual provider response still records
usage. All live guards also check the persisted deadline, active run identity,
run/agent status and boot ID, so correctness does not depend on a timely timer.

`withActiveWrite` serializes a short database write against cancellation and
supersession and checks time again before commit. A write crossing the deadline
rolls back; the timeout transition then commits separately. Do not invoke another
service's transaction from its callback: use the supplied transaction.

For Git/filesystem work, C04/D02 must hold the appropriate mutation gate and call
`assertActive` immediately before accepting each effect. A promise race cannot
undo arbitrary side effects performed by a tool. Do not publish an unguarded
write merely because `generate` previously returned a valid response.

C04 implements that boundary using the guarded Git checkpoint capability and
`withActiveWrite` under the workspace lock. `WorkerExecutor` retains the scope
across tool repairs, provider backoff and question waits; see the
[worker integration notes](../workers/README.md). C05 owns dispatch and C06 owns
durable cancellation and run finalization.

Timeout marks the agent `timed_out`, expires its open questions, retains call
reservations and accepted checkpoints, emits one durable event, and marks the
task incomplete. Token exhaustion follows the same pattern. Other parallel
agents can still finish. `StartOrchestrator` aggregates their states,
terminalizes the run and clears `active_run_id`; C02 does not prematurely
terminate peer assignments. New attempts remain protected by the existing unique
active-run index until that finalization occurs.

The question answer path now locks the task before the question, matching
deadline/cancel lock order, and commits question expiry before returning its
error. This prevents deadlocks and rollback of the expiry transition.

## Verification

```sh
npm run test:agents --workspace @app/server
npm run test:models --workspace @app/server
npm run build
npm test
```

The agent suite uses the real isolated PostgreSQL test database and a scripted
model adapter. It exercises concurrent reservations, independent budgets,
retained usage across attempts, duplicate request rejection, late billing,
abort-ignoring providers, human waits, deadline/write races, and expired answers.
No test contacts Gemini or requires an API key.

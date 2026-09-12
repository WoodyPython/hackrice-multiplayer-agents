# C03: orchestrator plans and graph validation

C05 now consumes these saved plans through `ParallelAssignmentScheduler`.
See [scheduler integration and D05/C06 handoff](SCHEDULER.md).

`OrchestratorPlanner` implements the shared `OrchestratorPlanningService` seam.
It consumes an existing planning instance and immutable captured context, obtains
a structured plan through C02's execution wrapper, validates it, and atomically
stores the accepted plan with planning completion. It does not create worker
instances, dispatch workers, capture live drafts, or wire the HTTP Start hook.

```ts
const planner = new OrchestratorPlanner({
  db, ledger, adapter, bootId: config.bootId,
  onBackgroundError: () => logger.error('Planning accounting persistence failed'),
});

// C06 first captures the run inputs and creates its orchestrator instance.
const plan = await planner.plan({ runId, agentInstanceId, context });
// C05/C06 may now persist the validated dependency graph and dispatch workers.
```

## Captured input contract

`PlanningContext` and its Zod schema live in `@app/contracts`. C06 supplies the
captured task title/outcome/criteria/intended outputs, guidance, manifest,
discussion entries, and selected source text. The planner never reads the live
task's text or latest discussion as a substitute. Its version/cutoff checks use
the run's fixed fields, even when live requirements have subsequently changed.

The run must have `input_snapshot_sha` and `context_manifest`. Its planning
instance must belong to that run and current boot, use preset `orchestrator`,
and retain the reserved `orchestrator` agent key. The manifest must match the
stored manifest exactly. Discussion after the cutoff is rejected. Every selected
material, approved path and draft path must appear once in the provided sources;
unselected or duplicate sources and mismatched material hashes are rejected.
C06 owns loading the actual captured bytes and guidance, including the union of
direct task attachments and explicit selected materials.

The context is copied synchronously before any asynchronous work. The saved
artifact contains its digest and input snapshot SHA. Capture identity is checked
again inside the completion transaction. Replaying a completed plan returns the
saved plan only for the same captured context and snapshot.

The existing `AgentService.plan({ runId, manifest })` remains C06's outer entry
point: its implementation must load the captured context and planning instance,
then delegate to this narrower C03 service. Posting tasks remains inert.

## Validation and repairs

`validatePlan(unknown)` returns either `{ valid: true, plan, order }` or structured
`PlanValidationError[]`. `order` is a topological order, not a dispatch schedule:
independent assignments remain eligible for parallel work.

- Provider output uses strict camelCase fields. Unknown fields, misspelled
  dependencies, missing arrays, blank instructions, and unknown presets fail.
- Assignment IDs are unique. The planning key is reserved; workers cannot create
  orchestrators. Dependencies exist, do not repeat, and form an acyclic graph.
- Analyst and reviewer scopes are empty. Writer/coder scopes contain exact
  canonical relative file paths under `documents/` or `code/`.
- Traversal, absolute paths, backslashes, control characters, globs, Git metadata,
  `.gitattributes`, `.gitmodules`, Windows device names, and ambiguous path
  spellings fail. D02's supported-text-extension rules, reserved hooks/short-name
  paths, and directory-prefix casing apply too. Case aliases and file/directory
  collisions fail even if ordered. Cross-layer tests compare these checks with D02.
- Multiple workers can write the same exact file only when a direct or
  transitive dependency orders them. Shared prerequisites alone do not order
  sibling workers. Read-only assignments can overlap freely.
- There is no assignment-count or dependency-count ceiling. The old 64-step
  and 50-dependency parser limits were removed. C02's tokens and deadline still
  bound model generation and repair attempts.

Invalid JSON, graph errors, and truncated responses request a complete corrected
plan. Each request has a new ledger key and retains the same instance budget and
deadline. Assistant history retains the complete adapter response, including
opaque provider state/thought signatures. There is no fixed number of repairs.
Transient provider errors use deadline-bound exponential backoff (1–30 seconds).
Missing usage holds its reservation, so it may leave no budget for another call.

Blocked responses and unsolicited tool calls fail planning. The planner exposes
no tools and executes none. A parseable JSON object is never accepted from a
truncated or otherwise unfinished response. Captured source content is prompt
data; it cannot authorize models, tools, broader scopes or extra budgets.

## Persistence, cancellation and handoff

`PgPlanStore` uses the existing `task_events` table. One `agent.completed` event,
keyed by the planning instance's completion key, contains `{ agentId,
contextDigest, inputSnapshotSha, plan }`. Its insert and the instance's completed
status commit in the same `ledger.withActiveWrite` transaction. A deadline or
cancellation crossing that transaction rolls both back. No database migration
or new dependency is needed. Invalid plans never enter this event.

Concurrent calls on the same service coalesce by instance and input digest.
The durable completion key also prevents competing service instances from
overwriting a plan. C05/C06 should load/revalidate the artifact, instantiate
workers with stable logical keys, and persist all dependencies before opening
execution scopes. A model-provided assignment ID is never a filesystem path or
Git ref. Carry stable keys/prior plans forward when coordinating manual retries.

B07 is integrated: create worker instances through the sole `PgAgentLedger`,
then call `PgRunStore.linkDependencies(runId, plan)` before consulting
`readyInstances(runId)` or starting any worker. The compatibility test covers
this handoff and verifies the ready worker still has no running clock. C03 does
not automate dispatch. The repository's existing migration `0006` supplies the
terminal-instance database guard; keep migrations current after pulling main.

`cancel(agentInstanceId)` aborts local planning, including calls still opening
their scope. C06 must also use the durable task cancellation path. Late provider
usage is reconciled without accepting the late plan. Fatal planning errors record
the agent as failed, mark the task incomplete, and emit `agent.failed` with a safe
error code. C02 owns timeout/exhaustion transitions; C06 owns terminalizing the
run and clearing its active-run pointer on failure/cancellation.

Syntax checks cannot see symlinks, special files, or stale file hashes. C04/D02
must still enforce real worktree containment, exact scopes, live run/boot and
deadline guards immediately before each effect. Optional task output paths are
intent, not a substitute for those controls. No model owns publication rights.

## Verification

```sh
npm run test:planning --workspace @app/server
npm run build
npm test
```

The focused suite checks graph/path edge cases and uses real isolated PostgreSQL
with a scripted adapter for repair, accounting, immutable context, replay,
cancellation and atomic completion. No Gemini key or network call is required.

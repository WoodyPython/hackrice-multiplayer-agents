# C08: manual retries and failure cases

`POST /api/workspaces/:workspaceId/tasks/:taskId/retry` creates one new explicit
attempt through the existing B03 Start transaction. The body is:

```json
{
  "clientRequestId": "UUID",
  "expectedVersion": 2,
  "savedOutputs": [{ "agentInstanceId": "UUID", "path": "documents/answer.md" }]
}
```

`expectedVersion` is optional for existing clients; supplied stale versions
are rejected. `savedOutputs` defaults to an empty array. The server accepts
only checkpoint files from terminal attempts of this same workspace/task. It
resolves their final accepted SHA inside the task lock. A client cannot submit
a SHA, an arbitrary file, another task's instance, or duplicate selections.
Idempotent replay returns the original run and its original selections, even
if a request is repeated after the run finishes. Concurrent distinct intents
still pass through the existing active-run guard.

`GET .../tasks/:taskId/saved-outputs` lists selectable checkpoint paths with
their agent/run IDs and immutable commit SHAs. Scopes alone do not prove a file
was written: candidates come from C04 checkpoint receipts. Failed, canceled,
timed-out and interrupted workers may have valid saved checkpoints. The list
includes a deletion as a saved absence; reading it returns null text/hash.

## New context, retained assignments and accounting

A retry captures the current task version, guidance, discussion cutoff,
materials and human draft through C06. Earlier run manifests, Git commits,
usage and evidence are retained. Selected saved files enter the new manifest
as `savedOutputs` with server-issued selection IDs and exact blob hashes.
They never overwrite main, the human draft, or the new worker base.

When a validated assignment plan exists, Retry reuses that graph, IDs and
scopes. New instances execute fresh tool calls against the new capture. The
synthetic planning instance records the reused plan without making another
provider request. This retains the `(task_id, agent_key)` budget identities
and prevents a renamed retry plan from resetting the workers' budgets. Current
requirements still apply; workers must ask for clarification if their saved
scope is insufficient. Use the separate Start/revision flow to request a new
assignment plan. If no plan was ever accepted (for example, initial planning
failed), Retry plans normally on the existing orchestrator budget.

The retry identity, plan and pinned selections are stored in the new run's
`task.started` event in the same transaction as the run. No migration is needed.
C05 continues to require a saved validated plan and successful integration
receipts. No old tool call or branch is automatically replayed.

Workers read selected checkpoint content through the existing `read_file` tool:
`source: "saved"`, `savedOutputId`, and `path`. Selection IDs are references,
not permissions to choose arbitrary instances or commits. The server checks
the captured selection and hash on each read and issues versioned evidence
references. The planner receives selected saved text in captured context when
new planning is needed. Ordinary current-file proposals still require fresh
worker-file hashes.

Each fresh execution instance gets its own fixed 600-second deadline. Consumed
tokens and unknown reservations remain on the original task/agent budget.
Unknown usage can exhaust a retry before another provider call; reconciliation
of the original call can release its reservation later. Late responses may
settle billing but cannot complete old work or overwrite a newer attempt.

C08 also closes a shutdown race in C06: capture/planning that finishes after
`close()` cannot start a new planning or worker scope. Interrupted rows remain
for D08 recovery rather than automatically resuming.

## Verification and remaining integration

`npm run test:retry --workspace @app/server` exercises real PostgreSQL, Git,
C02 accounting, C03/C05/C06 orchestration and C04 tools with scripted providers.
It covers partial-checkpoint reuse, current draft/version capture, stable keys,
fresh clocks, unknown usage/exhaustion, late billing, cancellation of an
abort-ignoring provider, concurrent idempotent retries and the existing
`PgRunStore.markInterruptedFromPreviousBoots()` seam.

`npm run gemini:smoke --workspace @app/server` performs two synthetic real calls
(orchestrator and writer), each with a 256-token output ceiling, using exact
input counting and C02 reservations. It creates/removes its own synthetic
database records, sends no workspace content, and logs only usage/status.
Real-call verification is currently blocked: `GEMINI_API_KEY` is not configured.

D08 has not landed: runtime startup does not yet invoke prior-boot interruption
or reconcile pending applies. The recovery method is tested as an explicit
handoff; this does not establish end-to-end restart recovery. C08's real-call
and D08 integration requirements therefore remain unverified. A05 can add the
saved-output picker using the additive endpoints above.

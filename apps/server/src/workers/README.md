# C04: worker tools and checkpoints

`WorkerExecutor` implements `WorkerExecutionService`. It runs one existing
assignment with C02's budget, deadline, provider retries and cancellation.
Import from `workers/index.ts`; inject the runtime's singleton ledger, model
adapter, `LocalGitService` and B04 material service.

```ts
const workers = new WorkerExecutor({
  db, ledger, adapter, git, materials,
  onBackgroundError: () => logger.error('Worker accounting persistence failed'),
});
const result = await workers.execute({ agentInstanceId, context: capturedContext });
```

C05 must create the instance with its validated preset/instruction/write paths,
link dependencies, select and persist `base_sha` after integrating prerequisites,
and create the mutating worker's branch using that base before dispatch. Readonly
workers read their base commit without requiring a worktree. Use one executor
per runtime; identical concurrent calls coalesce. This is not an automatic
restart/replay facility. Terminal instances cannot execute again. Manual retry
uses a new instance and the existing task/agent budget.

C06 supplies the original captured `PlanningContext`, retains the executor for
cancel/shutdown, sweeps deadlines, and finalizes runs after peers settle. Its
HTTP orchestration hook remains unimplemented here. Calling `cancel(id)` aborts
local work; the coordinator/task service owns durable cancellation. No route,
live Yjs mutation, result integration, approved-main publication or shell tool
is added by C04.

## Tools and scope

| Tool | Model arguments | Result |
|---|---|---|
| `read_file` | `path`, `source: worker / approved / draft` | Text, Git blob hash, issued reference |
| `read_material` | Selected `materialId` | Immutable text and issued SHA-256 reference |
| `propose_changes` | `changes: [{path, expectedHash, newText}]` | Checkpoint SHA and changed paths |
| `ask_question` | `body` | Waits for answer, then returns text and reference |
| `finish_assignment` | `summary`, `references`, `limitations`, `outputPaths` | Durable completion result |

Arguments are strict runtime schemas. No model argument supplies a workspace,
agent, run, base, worktree, scope, deadline, model setting or command. Analyst
and reviewer proposals are rejected even if the provider requests the tool.
Writer/coder changes must match the stored exact paths. D02 checks the complete
batch, portable filesystem paths, text limits and expected hashes before any
ref update. Creates use `expectedHash: null`; deletions use `newText: null` and
the existing blob hash. Stale batches return a structured error and require a
fresh read; they are not silently rebased or partially applied.

Approved and draft reads use the captured commit SHAs, never current main/live
draft text. Worker reads are limited to assignment paths, selected file paths,
and completed direct prerequisite paths on the integrated base. Completed prerequisite summaries, references,
limitations and artifact descriptors are included as generated context, including
readonly analyst results that have no changed files. Materials must
be listed in the persisted capture; both returned metadata and actual bytes
must match its SHA-256. File reads return content hashes, and nonexistent files
return null without a citation. Worktree locations and storage keys never enter
model results. Prompt bodies omit full material/source text until a read asks
for it. Source text and answers do not grant permissions.

`finish_assignment` must be called alone in a complete provider response.
References are IDs issued by successful reads/answers in this execution, not
arbitrary model-authored URLs. Completion resolves those IDs to source versions
and checks every output path against durable checkpoint receipts. Artifact
hashes are read from the final immutable worker commit; deletions have a null
hash. Model summaries and limitations remain generated claims for C07 review.

## Acceptance and persistence

`GuardedWorkerGitService.applyGuardedWorkerChanges` is a separate capability
from the existing unguarded backend API: old implementations cannot silently
ignore a new guard argument. `LocalGitService` implements it. Its guard runs
under the workspace operation lock, after candidate preparation and directly
before the branch compare-and-swap. It also runs for no-op batches.

C04 takes the task/run/agent row locks at that boundary, checks current boot,
active run, cancellation, terminal state, scope and deadline, then publishes.
Lock order is workspace Git lock then task/run/agent rows; no outer database
transaction is held while acquiring the Git lock or preparing a candidate.
Rejected guards preserve the previous branch. Accepted checkpoints record
`agent_instances.result_sha` and an idempotent `agent.checkpointed` receipt.

Git and PostgreSQL are not a distributed transaction. If the process, database
commit or worktree projection fails after ref publication, the Git checkpoint
remains the recovery authority. The worker stops; it never blindly repeats the
old proposal. Inspect/recover the saved branch in D08/manual retry. Cancellation
or timeout does not erase already accepted checkpoints. A guard authorizes the
short publication while cancellation/supersession are locked out; it cannot
undo a Git command already accepted before a local abort.

Questions use B03's existing records and answer endpoint. C04 inserts the entry,
question, waiting event and needs-input state in one guarded transaction; it
does not nest `PgDiscussionService.ask` inside a ledger transaction. The answer
wait polls only this question record, so an answer above the original discussion
cutoff reaches its worker without adding unrelated new discussion. Waiting,
tools and exponential provider backoff all consume the same 600-second clock.
No retry/tool-count quota is introduced.

Completion records `agent.completed` with `{ agentId, result }` and transitions
the instance atomically. Fatal errors record `agent.failed`, retain checkpoints,
and mark the task incomplete. C05/C06 own peer dispatch/integration and final run
status. Provider state and tool IDs are preserved across repairs, and late
provider usage is still accounted after cancellation.

## Verification

`npm run test:workers --workspace @app/server` runs real PostgreSQL and Git
checks with scripted models. `npm run build` and `npm test` cover integration.
No Gemini API key is required for tests.

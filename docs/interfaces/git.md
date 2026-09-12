# Git files and checkpoints

**Reflects:** D08, D07, C05 guard integration, C06 start snapshot · **Owner:** Role D

## Startup recovery (D08)

Pending/ambiguous publication receipts also block task/context mutations. Intent
creation locks workspace (NO KEY UPDATE), task, then review and revalidates the
candidate before inserting the receipt. No Git calls run in that transaction.
Reconciliation refuses to complete incompatible newer task state, records an
ambiguous receipt, and retains the published Git commit for manual investigation.
The workspace lock mode remains compatible with foreign-key checks by task writers.

Git object validation caches are confined to a single locked operation: at most
8 MiB/1,024 blobs and 10,000 entries/128 trees. Returned values are copied; refs,
disk files and worktree/index validation are never cached. Existing executable
text files retain their Git mode through checkpoints and worker replacements.
Preview validates the bound artifact and candidate without generating file diffs.

`startRuntime` interrupts previous-boot execution before building the application and calls `LocalReviewService.reconcilePreviousApplies()` before attaching live transport or opening orchestration. Its returned `recovery` contains interruption counts and apply counts (`applied`, `pending`, `ambiguous`). These are internal diagnostics; public API shapes are unchanged.

Exact candidate equality with main finalizes publication metadata and closes epochs using the same transaction as owner Apply, without moving Git. Exact expected-main equality leaves the operation pending for explicit owner-authenticated Apply with normal freshness checks. Any other main records `ambiguous`/`RUN_INTERRUPTED` and leaves Git untouched. Pending/ambiguous tasks retain the document-write guard. Unrelated tasks remain available. Storage failures abort startup and clean up resources; retry startup after resolving the storage failure.

Yjs snapshots restore saved text and revision on demand; Git checkpoints and worktree repair remain authoritative. Recovery does not replay execution, reset token budgets, or promise recovery of unacknowledged edits. C08 owns saved-output selection for explicit new attempts.

## Owner Apply and stale reviews (D07)

`POST /api/workspaces/:w/reviews/:r/apply` accepts strict
`{ candidateSha, clientRequestId? }` and the owner credential in `x-owner-key`.
It returns HTTP 200 with `{ status: "applied", appliedCommitSha, alreadyApplied }`.
The optional client request label does not replace the database's unique operation
per review. Missing and incorrect credentials return identical 403 responses.
The backend `ReviewService.apply` also accepts `ownerKey` and validates it itself.

The browser must send the candidate it displayed. Freshness checks compare task
and guidance versions, the D06 context/material union, run identity and result,
human branch head and lineage, approved main, and the entire live/persisted
document revision map. Changed sources return `REVIEW_STALE` (409); invalid source
artifacts return `INPUT_CONFLICT`. Request a fresh review after edits. Apply does
not capture newer text or replace the reviewed candidate.

Accepted Yjs state changes invalidate building/ready/conflict reviews and append
`review.stale` events before releasing the task gate, independently of snapshot
debouncing. Retransmissions and awareness do not invalidate. Failed invalidation
retains the accepted edit; live revisions still prevent publication. Applied
reviews remain immutable history. Migration `0007_stale_building_reviews.sql`
allows stale builds to have no candidate; ready/conflict/applied still require one.

Apply locks in this order: review task operation, workspace Git, document gate,
then database workspace/task/review/source rows. The pending operation commits
before the final SQL transaction. Only final validation and the guarded ref update
occur with the database row locks held; no capture or candidate build occurs there.
The internal Git/coordinator `withApply` callbacks expose bounded capabilities;
never call public Git or gate-taking methods recursively from those callbacks.

Git publishes the exact candidate with `update-ref main M A`. After success the
coordinator immediately closes rooms in memory, before any further database write.
One transaction then marks the operation/review applied, completes the task,
closes its stored epochs, and appends `task.applied`. The existing event pump
delivers refresh hints. Connected peers receive code 4409; A03/A06 must retain
late local text and stop reconnecting. Further editing uses a new task; old epoch
rows and Yjs state are retained, never seeded with approved output.

Authorized repeated Apply returns the saved success without republishing, even
if later tasks have advanced main. A pending operation at M finalizes metadata;
one still at A repeats all owner/freshness checks. A different head becomes
ambiguous and returns `RUN_INTERRUPTED`. Failed/ambiguous records are not reused
to publish new candidates. A database failure after Git leaves the operation
pending and rooms closed. Pending/ambiguous tasks reject live joins, updates, and
captures until reconciled. D08 supplies startup reconciliation as described above;
no workflow replay is performed.

`LocalGitService.applyExpected` is backend-only and returns
`{ applied, currentMainSha }`; it validates commits and compares the old main ref.
It does not perform ownership or review checks. Runtime HTTP callers use the
review service, never that low-level primitive directly.

## Start snapshot (section 8.4, added by C06)

`LocalGitService.combineStartSnapshot({ workspaceId, taskId, mainSha, draftSha })`
implements `StartSnapshotService` from `@app/contracts` and returns
`{ snapshotSha, conflicts }`. Exactly one is populated: a snapshot commit, or
the sorted paths that prevented one.

It combines approved main (A) with the human-draft checkpoint (L) into the
private starting snapshot S. When the draft already descends from main the
checkpoint *is* the snapshot and nothing new is written; when main has moved
independently, a three-way merge over their merge base produces a commit with
both as parents. Portable namespace collisions between the two trees are
reported as conflicts, with original paths rather than Git's synthesized names.

No ref is published: the snapshot is reachable once C05 creates the result
branch at it, and `gc.auto=0` keeps the loose commit until then. Main, the human
draft and every worker ref are read-only here — a contributor keeps typing on
their own lineage while a run is prepared. `draftSha` must be in the task's own
human lineage; a checkpoint from another task is refused rather than merged.
The three-way stage resolution is shared with D05's integration path.

## Combined review candidates (D06)

The runtime exposes `reviews: LocalReviewService`, wired to its existing Git
singleton and live-document coordinator. Preparation and resolution are
contributor actions. No migration or dependency is added.

| Route | Contract |
|---|---|
| `POST /api/workspaces/:w/tasks/:t/review` | No body or strict `{}`; returns `ReviewDetail` |
| `POST /api/workspaces/:w/reviews/:r/resolve` | `ResolveCandidateRequest`; returns `ReviewDetail` |
| `GET /api/workspaces/:w/reviews/:r` | Refetch stored review and current candidate detail |
| `GET /api/workspaces/:w/reviews/:r/diff` | `ReviewCandidateData`, diff against stored approved SHA |
| `GET /api/workspaces/:w/reviews/:r/preview?path=documents/example.md` | `ReviewPreview`: candidate text/hash, or null for absence |

Successful responses are HTTP 200. IDs and relationships are checked; callers
cannot supply source refs, revisions, a run, or filesystem locations. Preview is
JSON text for the existing safe Markdown renderer. Compare candidate SHAs across
separate reads, since resolution may advance the review between requests.

Before Request review, submit local edits and wait for their persisted
acknowledgements, as in D04 below. Capture includes every accepted active document;
typing resumes without a Yjs reset or epoch closure. Manual-edit tasks need no run
and record `runId/resultSha: null`. Agent tasks use the latest completed run with
a validated manifest, matching result branch/base, and completed instances. An
active, missing, incomplete, or mismatched result is refused; an older successful
attempt is not silently substituted. C05/C06 own constructing and settling runs.

### Conflict resolution

`ReviewDetail` contains `review`, `candidateSha`, `candidateComplete`, sorted
`changedFiles` (kind, unified diff, before/after blob hashes), `conflicts`, and
`generatedCodeWasNotExecuted: true`. No-change candidates have an empty diff.
Each conflict names its path and stage, with exact text/blob hash for each side:

- `human_agent`: `human_draft` and `agent_result`.
- `task_main`: `combined_task` and `approved_main`.

Both text and hash are null for absence. The two merges use their unique common
Git ancestor; missing or ambiguous ancestry returns `INPUT_CONFLICT`. All trees
undergo D02 path, namespace, UTF-8, and size validation.

Send `expectedCandidateSha` and exactly one resolution per displayed conflict:

```json
{
  "expectedCandidateSha": "<40-character candidate SHA>",
  "resolutions": [
    { "path": "documents/example.md", "choice": "manual", "text": "Resolved text" }
  ]
}
```

Alternatively choose an offered side without `text`. Choosing an absent side
deletes the file; empty manual text creates an empty file. Duplicate/extra/missing
paths, unavailable sides, unsafe content, and remaining namespace collisions are
rejected. Resolve every path in a stage together. Resolving `human_agent` can
reveal `task_main` conflicts: display those new sides and resolve again with the
new candidate SHA. Existing generic resolution schemas remain exported; D06's
strict wire schema is `resolveCandidateRequestSchema`.

Conflict records have a provisional SHA and `candidateComplete: false`. Their
preview preserves automatic merges when portable, otherwise the complete left
tree; it is not a chosen resolution. Candidate SHA and status are written
atomically, never temporarily `ready`. A clean candidate requires a stage-zero
Git index with no unresolved entries; literal marker text is ordinary content.
Ready transitions append `review.ready` in the same SQL transaction. Task status
becomes `conflict` or `ready_for_review`, including the direct manual-edit path.

Resolution creates a new commit and retains the previous candidate/source tuple.
Immutable refs under `refs/app/reviews/<reviewId>/<candidateSha>/` retain commits,
source ancestors, context, conflict sides, and resolution rounds. Temporary
detached worktrees/indexes are removed afterward. Main, worker, result, and human
branches are untouched. SQL uses the expected candidate/status; a failed
finalization preserves the private artifact without announcing readiness.
Failed initial builds remain `building`; request review again for a fresh build.

### Context and later-ticket handoff

`ReviewSource.contextHash` covers the complete review context, not D04's
draft-only digest. The private metadata retains current task requirements/output
paths, guidance/version, sorted selected inputs, the deduplicated union of
selected and task/discussion-linked material IDs/hashes, the completed run's
identity/manifest, and D04's capture. Object keys are recursively sorted; arrays
preserve semantic order except explicitly sorted sets. SHA-256 hashes canonical
UTF-8 JSON. Reads verify the digest and exact source tuple. Late discussion is
not added to the frozen agent manifest.

D07 implements continuous invalidation, persisted/in-memory revision checks,
source checks at Apply, ownership, publication, and epoch closure. `ready` alone
is not permission to publish. C07 owns AI review and revision assignments and
must bind findings to the examined candidate SHA. D08 owns workflow recovery.

Git `buildReview`, `readReview`, `resolveReview`, and `previewReview` hold the
existing workspace lock; callers resolve DB membership first. Review-service
operations have a task queue acquired before capture/Git. Never re-enter review
operations from a workspace lock or document gate. SQL transactions are short
and never held over Git or live capture.

The shared backend signatures remain supported: `prepare({workspaceId, taskId})`
returns `Review`, as does `resolve({workspaceId, reviewId, expectedCandidateSha,
resolutions})`. The runtime's positional overloads return `ReviewDetail` for its
HTTP handlers. New callers must supply `expectedCandidateSha`; its optional
declaration on the older shared interface preserves additive type compatibility,
while D06 validates it at runtime.

## Worker-result integration (D05)

`LocalGitService.integrate({ workspaceId, runId, agentInstanceId })` returns
`{ resultSha, conflicts }`. This is a backend-only coordinator operation on
completed, already accepted worker commits. UUIDs are validated and normalized.
The existing runtime singleton serializes integrations under its workspace lock.
Create the result at the captured start snapshot and each worker at the current
result head after its prerequisites integrate. Missing branches are rejected.

An empty `conflicts` list means `resultSha` is the resulting run head. Otherwise
it is the unchanged prior head, and `conflicts` contains sorted, unique original
paths. Text conflicts and portable namespace collisions (including case aliases
and file/directory collisions) preserve the whole result. Conflicts do not publish
partial files or marker text. Main, human drafts, worker refs, and Yjs are untouched.

Git 2.36 is sufficient: integration uses a temporary `read-tree -m` index and
`merge-file -p` for unresolved text stages. No checkout, merge driver, rename
inference, hooks, generated-code execution, or dependency is introduced. Clean
divergence creates a two-parent commit; a first worker fast-forwards. No-change
and already-integrated workers return the current result SHA without a new commit.

### C05 handoff

C05 uses the additive `LocalGitService.integrateGuarded(input, guard)` capability.
Besides workspace/run/agent IDs, input fixes `baseSha`, `workerResultSha`,
`expectedResultSha`, and exact `writePaths`. D05 checks all three Git sources
and the complete delta before preparing the merge. Under the workspace lock,
it invokes the supplied guard immediately before the result ref CAS (also on
no-op/conflict outcomes). The guard verifies current task/run/boot and durable
completion under database row locks, publishes, and records the integration
receipt plus result head atomically in the database. A rejected guard never
publishes. No database transaction surrounds Git preparation. The existing
unguarded method remains compatible for trusted backend callers.

C05 resolves workspace/run/instance membership, checks current run/boot and
cancellation, requires durable C04 completion, and validates the worker's stored
scope and final commit before calling. D05 has no database dependency; IDs alone
are not evidence of ownership or completion. Completed artifacts are integrated
by the coordinator; do not reopen a completed instance with `assertActive` or
change its immutable `agent_instances.result_sha`.

Keep integration and metadata recording ordered in C05: await a conflict-free
guarded integration and its committed receipt/result head, then release
dependents using the current integrated SHA as their persisted `base_sha`.
`readyInstances` currently tests completion only; C05 must additionally require
successful integration of mutating prerequisites. Read-only workers have no
worker branch and are handled by C05 without calling this method. C05 owns
blocked-assignment metadata, conflict events and dispatch; C06/C07 own run settlement.
Do not concurrently record an older return value after a newer result head.

A conflict never releases dependents. Git/validation failures also stop release.
`WORKTREE_SYNC_FAILED` means the result ref was published but projection failed;
retrying integration or `createResult` with its original base repairs projection
and preserves the commit. Already-integrated calls return the latest result head.
If database recording fails, retain Git as the saved artifact and stop dependent
dispatch; D08 owns cross-boot reconciliation. This is not automatic workflow replay.

## Live draft capture (D04)

The runtime now returns `collaboration`, its singleton
`LiveDocumentCoordinator`. The WebSocket server and checkpoint route use this
same registry. C06 and D06 should inject its
`capture({ workspaceId, taskId }): Promise<DraftCapture>` method; do not create
a second coordinator for the same runtime. Start orchestration remains C06;
D06 now consumes this capture for review.

Contributors can call
`POST /api/workspaces/:workspaceId/tasks/:taskId/checkpoint` with no body or
`{}`. The response is HTTP 200 with the existing `DraftCapture` shape:

```ts
{
  taskId: string;
  checkpointSha: string;
  documentRevisions: Record<string, number>; // draftFileId -> captured revision
  contextHash: string;
}
```

The route validates workspace/task UUIDs and their database relationship.
It does not require an owner key. Unknown body fields are rejected: callers
cannot supply text, paths, snapshots, revision claims, or ownership flags.
Neither Git paths nor Yjs binary state appear in the response.

### A03/A07 acknowledgement boundary

Before Save checkpoint, Start, or Request review, submit local changes and wait
for the persisted acknowledgement covering the latest accepted update from each
edited document, using the D03 tracking rules below. A provider sync event or an
older acknowledgement is insufficient. D04 does not add acknowledgement frames
or wait indefinitely for edits that have not reached the server.

Capture takes the workspace Git lock, then the task document gate. Update frames
already queued on that gate are processed first. While capture flushes all
accepted edits, exports text, commits, and records metadata, later update frames
wait. They resume in order after release and belong to the next draft revision.
Other tasks can keep accepting edits. The queued update frame budget is 8 MiB
per room; overflow disconnects the submitting socket with 1009 for normal
resynchronization. Capture never replaces a live Y.Doc or closes its epoch.

Every active task document is captured, including revision-zero documents and
unloaded persisted snapshots. Never-initialized documents are seeded once through
the existing database guard from the human branch (empty text for an absent
file). Human-branch files without active documents survive unchanged. A task
with no documents can still checkpoint its existing human branch.

`contextHash` is a lowercase SHA-256 of UTF-8 `JSON.stringify` applied to an
object with keys in this order: `taskId`, `checkpointSha`, `documentRevisions`.
The task ID and revision-map UUID keys are lowercase; the map keys are sorted
lexicographically. This digest identifies the draft capture only. It does not
hash requirements, materials, discussion, or C06's complete context manifest.
Identical text can reuse a Git SHA while a different Yjs revision changes this
digest (for example, an edit followed by undo).

### Durability and integration

After Git succeeds, one database transaction writes `draft_checkpoints` and a
`draft.checkpointed` event keyed by `eventKeys.draftCheckpointed(checkpointId)`.
Its payload contains `checkpointId`, `commitSha`, `documentRevisions`, and
`contextHash`. Each successful capture records an operation, even if its Git
head and digest match a previous capture. No broadcast implementation is added.

Closed epochs return `DOCUMENT_EPOCH_CLOSED`; unknown/scoped-out tasks return
`TASK_NOT_FOUND`. Save, restoration, Git-runtime, and metadata-recording failures
return `DRAFT_NOT_SAVED` without claiming checkpoint success. Existing Git
validation errors retain their codes. Saved Yjs edits remain durable even if
checkpointing fails. If Git succeeds but recording fails, the commit remains;
retrying unchanged content reuses that head. D02's worktree repair remains in
effect for `WORKTREE_SYNC_FAILED`. There is no rollback/reset or automatic
workflow replay. Shutdown drains captures and queued updates before flushing
rooms and closing the database.

`LocalGitService.withDraftCapture(input, callback)` is an internal scoped
primitive. Its callback owns the workspace lock and may acquire the task gate,
use its bound `readText(path)`/`checkpoint(files)` functions, then record the
capture. Never call public Git methods recursively inside it or retain those
bound functions after the callback returns. D07 implements
`CollaborationService.isCurrent` and `closeEpoch` on the same coordinator.

## Shared documents (D03)

The runtime attaches the live server to the same HTTP server as the API. It
uses the existing `PgDraftStore` and singleton Git service. One process owns
each data root; rooms and revisions are process-local until persisted.

Connect to `/live/:workspaceId/:taskId/:draftFileId/:epoch`. Obtain the document
ID and epoch through the existing draft open/list APIs. Every join validates
UUIDs, the full workspace/task/document relationship, and the stored epoch.
Paths come exclusively from the resolved database row. No owner key is needed
for shared editing; do not put one in the connection URL or awareness state.

The server loads persisted Yjs binary state first. Only an uninitialized row
is seeded from the committed human branch, or empty text for an absent file.
Concurrent joins share one initialization; a database initialization loser
adopts the winner's state. Reconnecting never refreshes text from Git.

### A03 connection contract

Use Yjs 13 and the stable `y-websocket` 3.x provider. All imports must use the
same ESM Yjs instance. The shared text is `doc.getText(LIVE_TEXT_NAME)`, where
`LIVE_TEXT_NAME` is exported by `@app/contracts` and equals `content`. Browsers
must start with an empty document, then bind the synchronized text to Monaco;
they must not independently seed the file text.

```ts
const provider = new WebsocketProvider(
  websocketOrigin,
  liveRoomPath({ workspaceId, taskId, draftFileId, epoch }).slice(1),
  doc,
  { connect: false, disableBc: true },
);
provider.messageHandlers[LIVE_MESSAGE_ACK] = (_encoder, decoder) => {
  const subtype = decoding.readVarUint(decoder);
  const revision = decoding.readVarUint(decoder);
  // Update the pending-submission/saved state described below.
};
provider.on('connection-close', (event) => {
  if (event?.code === LIVE_EPOCH_CLOSED_CODE) provider.shouldConnect = false;
});
provider.connect();
```

Import the path builder/constants from `@app/contracts` and `decoding` from
`lib0/decoding`. The `.slice(1)` is required: the provider inserts its own `/`.
Register the extension handler before connecting. Disable BroadcastChannel
for the persistence-aware binding so acknowledgements are received only from
the server and offline/closed-room edits are not exchanged around it.

Standard binary message types remain sync `0`, awareness `1`, and awareness
query `3`. Application acknowledgement type `4` is server-to-client only:
three lib0 unsigned varints `[4, subtype, revision]`. Subtype `0`
(`LIVE_ACK_ACCEPTED`) is sent to the submitting socket after each valid sync
step 2 or update, including retransmissions. Subtype `1`
(`LIVE_ACK_PERSISTED`) is broadcast after a successful save and sent on join.
`LiveAcknowledgement` exports the corresponding semantic TypeScript union.

Track outstanding submitted update frames as well as their accepted revisions.
Only show Saved once all local changes have been submitted and accepted, and
the highest persisted acknowledgement covers those accepted revisions. A
previous acknowledgement cannot cover edits still in transit or offline.
Include the reconnect sync-step-2 response in that accounting. Reset
connection acknowledgement tracking on reconnect and wait for the new sync
exchange. Neither the provider's `sync` event nor a state-vector comparison
proves persistence: deletion-only edits can leave the state vector unchanged.

Awareness uses the standard `user`/cursor payloads consumed by the Monaco
binding. It is ephemeral, unverified display data. Disconnects remove the
socket's awareness states, and ping/pong detects dead peers. Awareness does
not advance document revisions or enter snapshots.

### Saving, errors, and lifecycle

Accepted changes immediately advance the live revision and broadcast to peers.
Full binary snapshots and state vectors are saved in ordered per-document
writes after a 500 ms coalescing window. Continuous typing still gets periodic
saves. New edits during a save require a subsequent save. A skipped guarded
write (`applied: false`) is a normal success covered by the returned revision.

Transient save failures retain dirty state and retry; no persisted
acknowledgement is sent for the failed save. The last disconnect triggers an
immediate flush. A room is evicted only once saved and no pending join remains.
Shutdown stops sockets and flushes rooms before closing the database; failed
durability causes the runtime's existing shutdown-failure result.

Rejected upgrades return the existing JSON API error envelope:
`VALIDATION_FAILED`, `DRAFT_NOT_FOUND`, or `DOCUMENT_EPOCH_CLOSED` as applicable.
Browser WebSocket APIs do not expose HTTP rejection bodies; use the draft
open/list APIs to refresh document metadata when connection errors occur.
When persistence detects an epoch closed after connection, the server closes
the socket with code `4409` (`LIVE_EPOCH_CLOSED_CODE`) and reason
`DOCUMENT_EPOCH_CLOSED`. A03 must stop provider reconnection for that code and
keep local unsent text available for copying; do not replay it into a new epoch.

Invalid/non-binary/unknown frames close with `1008`; oversized frames use
`1009`. The binary message and snapshot limit is 8 MiB (CRDT history can exceed
plain text size); editable text retains the existing 1 MiB limit and rejects
NULs. Invalid Yjs updates are checked on a disposable copy before changing
authoritative state. Slow sockets exceeding the send buffer limit disconnect
and can resynchronize normally.

D03 does not expose snapshot-write HTTP endpoints or create checkpoints while
typing. D04 adds the explicit capture boundary above; D07 adds review invalidation
and Apply-driven epoch closure. Persisted snapshots restore on demand; workflow
restart reconciliation remains D08.

## Git files and checkpoints (D02)

`LocalGitService` implements the D01/D02 subset of `GitService`. Use the runtime's
existing singleton; its `withRepository` callback already holds the workspace
operation lock. A callback must not call another public Git service method.

All calls are backend-only. Resolve workspace/task/instance membership before
calling. C02/C04 must check current boot, cancellation, supersession, terminal
state and the fixed deadline, bind the worker instance, and supply authoritative
scopes. IDs, scopes, refs, filesystem paths and the runner are not model inputs.
The Git layer has no database or model dependency and cannot check agent state.

C04 now uses the additive `GuardedWorkerGitService` capability implemented by
`LocalGitService.applyGuardedWorkerChanges(input, guard)`. The same D02 batch
rules apply. After preparing the candidate, under the workspace operation lock,
Git calls `guard(checkpoint, publish)` immediately before ref publication. The
guard must invoke `publish` once only after accepting the worker's current
execution state. A rejection preserves the old ref; no-op batches also invoke
the guard. C04 owns the short task/run/agent DB lock inside that callback. Do not
hold an outer DB transaction while calling this Git method. Original unguarded
methods remain available for trusted non-worker callers and existing tests.

Guard errors retain their original type. Failures after publication can leave a
saved Git checkpoint even when its DB receipt or disk projection failed; stop
the worker and inspect the branch for recovery instead of replaying the batch.

| Method | Input and result |
|---|---|
| `createDraft` | `{ workspaceId, taskId }` → `{ branch }`; starts at current main once |
| `createWorker` | `{ workspaceId, agentInstanceId, baseSha }` → `{ branch, worktreePath }` |
| `createResult` | `{ workspaceId, runId, baseSha }` → `{ branch, worktreePath }` |
| `readText` | `{ workspaceId, target, path, allowedPaths }` → `{ path, text, hash }` |
| `checkpoint` | `{ workspaceId, taskId, files: [{ path, text }] }` → `{ commitSha }` |
| `applyWorkerChanges` | `{ workspaceId, agentInstanceId, allowedWritePaths, changes: TextChange[] }` → `{ commitSha, changedPaths }` |

`worktreePath` is for trusted backend use only. Do not serialize complete service
results to HTTP or pass them to a model. The lifecycle/start/room/tool integration
is owned by the respective later tickets; D02 adds no HTTP endpoint.

`GitReadTarget` selects an immutable commit SHA, a draft task ID, a worker instance
ID, or a result run ID. Branch reads resolve the head under the workspace lock
and return committed content even if ordinary worktree file bytes differ.
An allowed absent file returns `text: null, hash: null`. Create the draft/worker/
result before reading its branch; an unknown branch raises `INVALID_STATE`.

Hashes are Git **blob SHA-1**, not raw-content SHA-1 or material SHA-256. Pass the
hash from `readText` as `TextChange.expectedHash`. A create uses `null`; a deletion
uses `newText: null` and the existing non-null hash. Every accepted worker batch
is one atomic checkpoint. A stale member rejects the whole batch with
`FILE_VERSION_CHANGED` and `{ path, currentHash }`. Unchanged content returns the
existing commit and an empty `changedPaths` array.

Human `checkpoint` upserts every supplied file together. Omitted paths survive;
the existing human contract has no delete operation. Empty batches are valid.
D04 supplies acknowledged document text and records the revision map in the
database after Git success. D02 does not write `draft_checkpoints` or Yjs state.

Scopes are exact file paths below `documents/` or `code/`, with supported text
extensions. Backslashes normalize to `/`; aliases, metadata, symlinks, junctions,
hard links, special files, invalid UTF-8, NULs and files larger than 1 MiB are
rejected. Empty files and UTF-8 BOMs are preserved. Paths are portable across
Windows and Linux: no device names, streams, case collisions, decomposed Unicode
names, or file/directory substitutions. Server-owned logs live outside these
editable roots. Tree validation currently accepts only these editable roots;
later server-log publication must provide an explicit trusted path for logs.

Branches and worktrees use `human/<taskId>`, `agents/<agentInstanceId>` and
`results/<runId>`. Starting points are retained at
`refs/app/bases/<kind>/<id>`. UUIDs are lowercase. Reopening an existing human
draft retains its original lineage even after main advances. Worker/result reuse
with a different base raises `INPUT_CONFLICT`.

Missing worktrees are rebuilt from their branch after Git prunes stale worktree
registrations. Existing directories must have valid reciprocal Git registration;
unrecognized directories, including empty ones, are preserved and rejected.
Unknown edits/untracked files raise `DIRTY_WORKTREE` and are never discarded.
Refresh recovery compares against a server-recorded materialized commit, not the
Git index, so staging a local edit cannot make it eligible for overwrite.

Checkpoints construct a candidate using a temporary index, then update only the
intended ref with the previous head as a compare-and-swap guard. A failure before
that update preserves the old checkpoint. `WORKTREE_SYNC_FAILED` means the branch
commit succeeded but its disk projection needs repair: repeat creation or access
the worker through the service to repair, then re-read hashes before proposing
again. Do not reset the branch or blindly replay old expected hashes. Retrying
with the same instance preserves its base and committed history.

Git and files are accessed with trusted arguments and raw object I/O. Generated
code is never run. Start-snapshot combination landed with C06 above; reviews
landed with D06 above. Apply, execution-state recovery and branch retention
policies remain later tickets.

Verification: `npm run build`, `npm run test:git --workspace @app/server`, and
`npm test` (the last command rebuilds the separate test database).

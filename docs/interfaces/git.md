# Git files and checkpoints

**Reflects:** D02 · **Owner:** Role D

`LocalGitService` implements the D01/D02 subset of `GitService`. Use the runtime's
existing singleton; its `withRepository` callback already holds the workspace
operation lock. A callback must not call another public Git service method.

All calls are backend-only. Resolve workspace/task/instance membership before
calling. C02/C04 must check current boot, cancellation, supersession, terminal
state and the fixed deadline, bind the worker instance, and supply authoritative
scopes. IDs, scopes, refs, filesystem paths and the runner are not model inputs.
The Git layer has no database or model dependency and cannot check agent state.

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
code is never run. Integration, start-snapshot combination, reviews, Apply,
execution-state recovery and branch retention policies remain later tickets.

Verification: `npm run build`, `npm run test:git --workspace @app/server`, and
`npm test` (the last command rebuilds the separate test database).

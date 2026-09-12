# For Role D — Git and live runtime against the data layer

**Reflects:** B05, D02 · **Owner:** Role B (data), Role D (Git handoff)

D01 already integrates correctly: `GitWorkspaceLifecycleHook` honours the
fire-and-forget contract, `ensureRepository` provides the self-healing path, and
`recovery/runtime.ts` wires the application factory as design §15.1 specifies.
What follows is for D02 onward.

D02's implemented Git surface and the D03/D04 checkpoint handoff are documented
in [Git files and checkpoints](git.md), reflecting D02. The B05 persistence
surface below remains unchanged.

---

## `PgDraftStore` — persistence for shared documents

You own the live in-memory document, the update protocol, and awareness. This
owns what survives a restart.

| Method | Contract |
|---|---|
| `resolveRoom({workspaceId, taskId, draftFileId})` | Call before attaching any socket. Validates the whole triple against the database; raises `DOCUMENT_EPOCH_CLOSED` for a closed document |
| `load(workspaceId, draftFileId)` | Metadata plus `yjsState` / `stateVector`, both null until seeded |
| `initialize(draftFileId, {yjsState, stateVector, baseBlobSha})` | Seeds once |
| `persist(draftFileId, {revision, yjsState, stateVector})` | Revision-guarded write |
| `closeEpoch(workspaceId, taskId)` | After Apply. Idempotent; returns the number of rows closed |
| `openForTask` / `openNextEpoch` | The same operation: the active document, creating the next epoch if none is active |
| `listActiveForTask` | For the editor's file selector |

---

## Three behaviours that are easy to get wrong

**`persist` returning `applied: false` is normal.** It means a newer revision
already covers those updates. The guard is `WHERE persisted_revision < $revision`
in the statement, not a read-then-write, because two saves can be in flight at
once and any check before the UPDATE is stale by the time it runs. Do not retry
on it and do not surface it as an error.

**`initialize` returning `initialized: false` means someone else won — load
what they stored, do not merge your copy in.** Design §7.2: "merging separately
initialized copies can duplicate content." Two rooms can reach initialization
simultaneously, and the whole point of the guard is that the loser adopts rather
than merges.

**The initial text comes from Git, which this layer cannot read.** You supply
both the encoded document and the blob SHA it was built from.

---

## Room resolution

`resolveRoom` is what makes design §12.1's "a caller cannot pass an arbitrary
room name that opens a filesystem path" true rather than aspirational. Every
element of the triple is checked against the database rather than trusted from
the room name, and route-level UUID validation runs before that.

Call it before attaching a socket, not after.

---

## Epochs are rows, not a counter

Closing an epoch leaves the old record intact, so a browser holding unsent edits
against it can still be told what happened rather than having its document
silently redefined (design §7.6). Reopening the path creates epoch N+1.

Creation derives the next number from every epoch that has existed for that
path. Defaulting to 1 works exactly once — see
[`pitfalls.md`](../pitfalls.md#a-computed-key-defaulted-instead-of-computed).

---

## No HTTP route writes a snapshot

`persist`, `initialize`, and `closeEpoch` are **in-process calls only**. Design
§11.4 keeps browsers out of storage, and an endpoint accepting a Yjs snapshot
would let any link holder replace a document wholesale, bypassing every update
you validated. Opening a draft is the only part of that surface a browser
reaches. There is a test asserting those routes do not exist; if you need one,
that is a design conversation, not a route to add.

---

## What B07 will add for you

D05 and D06 depend on it: run snapshots, agent instances and dependencies,
review source tuples, and the single pending apply record with its
reconciliation. The tables and constraints exist from B01; the transactional
operations do not yet.

The review source tuple is `(taskVersion, guidanceVersion, mainSha, humanSha,
resultSha, documentRevisions, contextHash)` — `ReviewSource` in
`@app/contracts`. Apply re-validates every element, and
`CollaborationService.isCurrent` must check in-memory dirty state, not only the
persisted row (design §7.6).

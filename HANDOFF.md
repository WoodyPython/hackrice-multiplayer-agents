# Handoff notes from Role B

What the data layer guarantees, what it deliberately does not do, and the
decisions that would be expensive to discover by reading the code.

The design document is the specification; this is the part that only matters
once you are wiring against it. Where the two disagree, the design document
wins and this file is stale — say so.

**Status:** B01–B05 complete. D01 complete.

---

## Read this first, whatever your role

**Import from `@app/contracts`. Do not redeclare.** Schemas, status vocabularies,
error codes, the section 12.3 interfaces, and the fixed limits all live there.
It is additive-only until integration: add freely, rename nothing.

**Every non-2xx response has the same shape.**

```json
{ "error": { "code": "TASK_VERSION_CHANGED", "message": "...", "details": { "currentVersion": 3 } } }
```

`details` is for your code, not your UI. It carries the current version behind a
version conflict, the field errors behind a validation failure, the conflicting
path behind a manual-edit collision.

**Codes you will actually hit:** `VALIDATION_FAILED` (400), `TASK_VERSION_CHANGED`
(409), `TASK_ALREADY_RUNNING` (409), `INVALID_STATE` (409, with
`details.currentStatus`), `OWNER_KEY_REQUIRED` (403), `DOCUMENT_EPOCH_CLOSED`
(409), the `*_NOT_FOUND` family (404), `RATE_LIMITED` (429).

**Anything that can be double-submitted takes a `clientRequestId`.** Posting a
task, adding a discussion entry, starting a run. Send a fresh UUID per user
intent and reuse it on retry; a replay returns the original result rather than
creating a second one.

---

## Role A — frontend

**The owner key goes in the `x-owner-key` header.** Never in the URL, never in a
body. An `isOwner: true` field in a request body is ignored — the server checks
the key every time, so hiding a button is a presentation choice, not a control.
`GET /api/workspaces/:w` returns `isOwner` computed from the header you sent;
use it to render, never to authorise.

**Store the key once, at creation.** `POST /api/workspaces` returns it exactly
once. There is no endpoint that reads it back and no recovery flow. If the
browser loses it, that workspace has no owner forever.

**Status codes carry meaning beyond success.**

| Call | Codes | What the difference means |
|---|---|---|
| `POST /materials` | 201 / 200 | 200 means identical bytes already existed and the existing material was reused. Do not render a second card |
| `POST /drafts/open` | 201 / 200 | 200 means you joined an existing editing session rather than starting one |
| `POST /tasks/:t/start` | 202 | Accepted, not finished. The run exists; planning has not happened yet. `idempotentReplay: true` means your request was a duplicate |

**Uploads are `multipart/form-data`**: one file part named `file`, plus a
`guestLabel` text field and optional `taskId` / `discussionEntryId`. Materials
are UTF-8 text only — Markdown, plain text, and the code extensions in
`SUPPORTED_TEXT_EXTENSIONS`. A PDF or an image is rejected with
`VALIDATION_FAILED`, so say so in the picker rather than letting someone
discover it by dragging a file in.

**Material downloads always come back as `text/plain`** with an attachment
disposition, whatever the file actually is. That is deliberate: serving an
uploaded `.html` as HTML from the API origin would be stored cross-site
scripting. Render previews yourself from the text.

**Discussion is cursor-paginated by `seq`**, not by timestamp. `GET .../discussion`
returns `latestSeq` and `activeRunCutoffSeq`; each entry carries
`afterActiveRunCutoff`, which is what drives the "Added after this run started"
label. Poll with `?afterSeq=`.

**Version conflicts are normal, not errors to hide.** `PATCH /tasks/:t` requires
`expectedVersion`; a 409 carries `details.currentVersion` so you can refetch and
re-apply rather than showing a dead end.

---

## Role C — Gemini orchestration

**The context manifest must union two sources.** Section 3.3 says direct task
attachments are selected by default, and "selected by default" is not a stored
row. A material attached to a task is in context without any
`task_input_links` record, so the manifest is:

```
explicit inputs (GET /tasks/:t → inputs[])
  ∪ task-attached materials (GET /tasks/:t/materials)
```

Reading only the input links silently drops every attachment from every run.
Writing a selection row at attach time is the tempting alternative and is wrong:
a later wholesale replacement of inputs would drop it just as silently.

**`OrchestrationHook.onRunCreated` is your entry point.** B03 creates the run row
inside the Start transaction and calls you after commit. When you receive it:

- `task_version`, `guidance_version`, `discussion_cutoff_seq`, and `boot_id` are
  already fixed and must not be edited. You fill `input_snapshot_sha` and
  `context_manifest` after capture.
- **Never throw back into the caller.** The HTTP response has already been sent.
  On failure, end the run in a terminal state with a task event saying why — a
  run stuck in `planning` forever is worse than a failed one.
- Check `boot_id` before any write. A run from a previous boot is interrupted,
  and its late results must be rejected (section 14.4).

**The discussion cutoff is absolute.** Entries above `discussion_cutoff_seq`
never enter any agent's context for that run, including assignments that have
not started. The one exception is an answer to a question the run itself asked,
which reaches the waiting agent through its question record.

**Agent questions are records, not formatted comments.** `ask()` writes an
`agent_questions` row and renders it as a discussion entry; an agent may have
only one open question at a time. Two things to know:

- A question expires at its agent's existing deadline. Asking never extends it.
- **We both resolve expired questions.** Your deadline sweep does, and so does
  the answer path, which treats `expires_at` as authoritative and returns
  `AGENT_TIMED_OUT` rather than recording an answer no agent will read. Both are
  idempotent, so they cannot fight — but do not assume you are the only writer.

**`needs_input` is derived, not set.** A task reports it while its active run has
an open question and leaves when none remain. Do not set the task status
directly for this.

**Budgets survive everything.** `task_agent_budgets` is keyed by
`(task_id, agent_key)` and is never reset — not by retry, not by a new attempt.
An exhausted budget stays exhausted (section 14.3). The row deliberately has no
`consumed + reserved <= budget` check, because section 9.2 records late usage
after a deadline abort and reconciliation can legitimately overshoot.

**Materials reach you pre-validated:** guaranteed UTF-8, under 1 MiB, no NUL
bytes. No defensive decoding needed.

---

## Role D — Git and live runtime

**D01 already integrates correctly** — `GitWorkspaceLifecycleHook` implements the
contract, including the fire-and-forget catch and `ensureRepository` for
self-healing, and `recovery/runtime.ts` wires `buildApp` properly. The notes
below are for D02 onward.

**`PgDraftStore` is the persistence layer for shared documents.** The room server
owns the live in-memory document and the update protocol; this owns what
survives a restart.

| Method | Contract |
|---|---|
| `resolveRoom({workspaceId, taskId, draftFileId})` | Call before attaching any socket. Validates the whole triple against the database and raises `DOCUMENT_EPOCH_CLOSED` for a closed document. This is what makes "a caller cannot pass an arbitrary room name" true |
| `load` | Returns metadata plus `yjsState` / `stateVector`, both null until seeded |
| `initialize` | Seeds once. `initialized: false` means someone else won — **load what they stored, do not merge your copy in** |
| `persist` | Revision-guarded. `applied: false` is **normal**, not an error |
| `closeEpoch` | After Apply. Idempotent; returns how many rows it closed |
| `openForTask` / `openNextEpoch` | Same operation: the active document, creating the next epoch if none is active |

**`persist` returning `applied: false` means a newer revision already covers
those updates.** The guard is `WHERE persisted_revision < $revision`, in the
statement rather than a read-then-write, because two saves can be in flight at
once. Do not retry on it and do not surface it as an error.

**There is deliberately no HTTP route that writes a snapshot.** `persist`,
`initialize`, and `closeEpoch` are in-process calls only. An endpoint accepting
a Yjs snapshot would let any link holder replace a document wholesale, bypassing
every update you validated. Opening a draft is the only part of that surface a
browser reaches.

**Seeding races are real.** Two rooms can reach initialization at once, and
merging two separately initialized copies duplicates the text — section 7.2 is
explicit about this. The store refuses the second seed; honour the
`initialized: false` answer.

**Epochs are rows, not a counter.** Closing an epoch leaves the old row intact so
a browser holding unsent edits can be told what happened. Reopening creates
epoch N+1.

---

## Gotchas that have already cost time

**Matching a Postgres violation by constraint name has a sharp edge.** When a
table has several unique indexes that one insert can trip, the database reports
whichever it checks *first* — the constraint declared with the table, not the
partial index added in a later migration. A handler naming the partial index
compiles, reads correctly, and never runs.

This was live in `draft_files` for the whole of B05: 18 of 18 violations arrived
as `draft_files_epoch_uq` while the handler watched for `draft_files_active_uq`.
It surfaced as an intermittent 500 in about two runs in three.

Two ways out. Where the operation is find-or-create, treat **any** unique
violation as "someone else got there first" and re-read. Where outcomes must be
distinguished, take the row lock first — that is why `start()` can safely match
`runs_active_uq` by name despite `runs` having five unique indexes.

**A computed key needs the computation, not a default.** The same function had a
second, deterministic bug: creating a document defaulted to epoch 1, which works
exactly once. After Apply closes an epoch, inserting epoch 1 again collides with
the closed row, and the active-document lookup cannot see that row to recover.
Every reopen after Apply failed.

**Write concurrency tests with rounds, not a single pass.** Whether two writers
genuinely overlap is a timing accident. A one-round test passed roughly a third
of the time against a race that was broken in every run.

**Assert the status code before you aggregate.** The convergence test folded
responses into a `Set` to check they agreed. A failing request contributed
`undefined`, so a 500 read as "two different values" — a convergence bug, in the
wrong place entirely. Check success first, then compare.

**Anything expressed in both SQL and TypeScript will diverge.** A status set in
an index predicate and also in a constant cannot be kept in sync by discipline.
`schema.test.ts` reads the live index definition out of `pg_indexes` and compares
it to the constant, in both directions.

---

## Running things

`SETUP.md` has setup, verification, and per-role starting points. After any
pull: `npm install && npm run db:migrate`.

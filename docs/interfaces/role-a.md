# For Role A — calling the API

**Reflects:** B07, C06, C08, D06, the Supabase verification of 2026-09-12, and the
A04 draft listing · **Owner:** Role B

What the frontend needs from the data layer. Shapes and enums live in
`@app/contracts` — import them rather than transcribing anything here.

---

## Every response

Non-2xx responses all carry one envelope:

```json
{ "error": { "code": "TASK_VERSION_CHANGED", "message": "...", "details": { "currentVersion": 3 } } }
```

`details` is for your code, not your UI. It carries the current version behind a
version conflict, the field errors behind a validation failure, the conflicting
path behind a manual-edit collision.

Codes you will actually hit:

| Code | Status | What to do |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Show field errors from `details.fields` |
| `TASK_VERSION_CHANGED` | 409 | Refetch, re-apply the edit, resubmit. `details.currentVersion` |
| `TASK_ALREADY_RUNNING` | 409 | A run is already active; offer Stop |
| `INVALID_STATE` | 409 | The action is legal but not from here. `details.currentStatus` |
| `OWNER_KEY_REQUIRED` | 403 | Hide or disable the owner control |
| `DOCUMENT_EPOCH_CLOSED` | 409 | The document was closed. Keep unsent text visible, open the current draft |
| `*_NOT_FOUND` | 404 | — |
| `RATE_LIMITED` | 429 | Workspace creation only |

---

## The owner key

Goes in the **`x-owner-key` header**. Never in a URL, never in a body. An
`isOwner: true` field in a request body is ignored: the server checks the key on
every owner operation, so hiding a button is presentation, not access control.

`GET /api/workspaces/:w` returns `isOwner` computed from the header you sent.
Use it to render.

**Store it once, at creation.** `POST /api/workspaces` returns it exactly once.
No endpoint reads it back and there is no recovery flow — if the browser loses
it, that workspace has no owner forever. Design §1.2 is deliberate about this.

In development the API is cross-origin, and `x-owner-key` is not a simple
header, so it triggers preflight. It is already in the allowed-headers list; if
you see an opaque CORS failure on an owner call, that is the thing to check.

---

## Status codes that carry meaning beyond success

| Call | Codes | The difference |
|---|---|---|
| `POST /materials` | 201 / 200 | **200** means identical bytes already existed and the existing material was reused. Do not render a second card |
| `POST /drafts/open` | 201 / 200 | **200** means you joined an existing editing session rather than starting one |
| `POST /tasks/:t/start` | 202 | Accepted, not finished. The run exists; planning has not happened. `idempotentReplay: true` means your request was a duplicate |

---

## Idempotency

Anything double-submittable takes a `clientRequestId`: posting a task, adding a
discussion entry, starting a run. Send a fresh UUID per user intent and reuse it
on retry. A replay returns the original result rather than creating a second one,
so a double-tapped button is safe.

For manual retries, use `GET /api/workspaces/:w/tasks/:t/saved-outputs` to list
accepted checkpoint files, including partial output from failed attempts.
`POST .../tasks/:t/retry` accepts `clientRequestId`, optional `expectedVersion`,
and optional `savedOutputs: [{ agentInstanceId, path }]`. Send the selection
identities, not the returned commit SHA. A replay preserves the original
selection. Retry uses current requirements and draft with the saved assignment
graph and retained budgets. See [C08](../../apps/server/src/orchestration/RETRY.md).

---

## Materials

Upload is `multipart/form-data`: one file part named `file`, a `guestLabel` text
field, and optional `taskId` / `discussionEntryId` selecting which of design
§3.2's three locations applies.

**Text only** — Markdown, plain text, and the code extensions in
`SUPPORTED_TEXT_EXTENSIONS`. A PDF or an image is rejected with
`VALIDATION_FAILED`. Say so in the picker rather than letting someone find out
by dragging a file in.

**Downloads always return `text/plain`** with an attachment disposition,
whatever the file actually is. That is deliberate: serving an uploaded `.html`
as HTML from the API origin would be stored cross-site scripting. Render
previews yourself from the text.

`GET /materials/:m/meta` returns metadata without the bytes, for pickers.

---

## Discussion

Cursor-paginated by `seq`, not by timestamp. `GET .../discussion` returns:

- `entries[]`, each with `seq`, `actorType`, `materialIds`, and `question`
  (non-null when the entry is a question or its answer)
- `latestSeq` — the highest allocated, so you can tell if you are behind
- `activeRunCutoffSeq` — null when no run is active

Each entry carries `afterActiveRunCutoff`, which is what drives the
"Added after this run started" label from design §2.3. Poll with `?afterSeq=`.

---

## What a started run does now (C06)

Start is no longer inert. After the 202, the task moves on its own and reaches a
terminal state on **every** path, so no run sits in `planning` forever:
`working` once assignments dispatch, then `ready_for_review`, `conflict`,
`incomplete`, or `canceled`. Poll the task and its events; nothing pushes.

Alongside the agent events, the run emits `agent.waiting` entries keyed
`run:<runId>:start:<reason>` with `payload.phase === 'start'`. The reason is a
stable code, never a message, and is safe to render or map to your own copy:

| Reason | What to show |
|---|---|
| `context_captured` | Inputs are frozen; `payload.omitted[]` lists selections that could not be captured (a deleted material, a path absent from main) |
| `snapshot_conflict` | Approved main and the draft could not be combined; `payload.paths[]` are the files. The task is in `conflict` |
| `integration_conflict` | Worker outputs conflicted; `payload.paths[]` are the files |
| `assignments_incomplete` | At least one assignment failed, was blocked, or never integrated |
| `task_version_changed`, `guidance_version_changed` | The task moved between Start and capture; start a fresh attempt |
| `model_configuration` | The server has no provider key configured |
| anything else | A generic failure; show saved work and offer retry |

Never show these codes raw as the primary message, and do not parse them for
detail beyond the table: the codes are stable, the set is not closed.

---

## Review evidence and a fresh assessment (C07)

Two additions to D06's existing review routes, for A06:

- `GET /reviews/:r/evidence` → `ReviewEvidence`: real `changedFiles`,
  `agentSummaries` (each labeled generated, carrying `examinedSha` and a
  `staleAgainstCandidate` flag — render that distinctly, e.g. "may be out of
  date" rather than silently dropping it), `validationsPerformed` (real
  server checks, `passed`/`detail`), and `generatedCodeWasNotExecuted: true`.
- `POST /reviews/:r/assess` → `ReviewAssessment`, no body. Triggers one fresh
  reviewer pass against the candidate held right now. Idempotent per exact
  candidate: calling it again before the candidate changes returns the same
  finding rather than running a second one, so a retry button is always safe.
  Errors map to `REVIEW_NOT_FOUND`, `AGENT_TIMED_OUT`, `AGENT_TOKEN_EXHAUSTED`,
  or `INVALID_STATE` — the usual table above applies.

Neither route mutates the review or its candidate; both are safe to call from
a read-only review screen.

---

## Staying current: events and refresh hints

Two pieces, and the split matters. **Durable events are authoritative; realtime
is only a prompt to come and read them.**

`GET /tasks/:t/events` is the progress record — cursor-paginated by `id`, so a
browser that was disconnected reads forward from where it stopped rather than
re-reading everything. The response carries `events[]` and `latestId`. Poll it
with `?afterId=`.

`GET /workspaces/:w/realtime` tells you how to subscribe:

```json
{ "channel": "workspace:<id>",
  "realtime": { "url": "...", "publishableKey": "..." } }
```

**`realtime` is `null` when no Supabase project is configured.** That is not an
error — fall back to polling the events route. Design §5 specifies polling as
the fallback, and events are authoritative either way, so the difference is
latency, not correctness. Build the polling path first; realtime is a latency
optimisation layered on it.

Both branches are now reachable, which they were not before. A project is
configured (2026-09-12) and the server's broadcasts are verified as accepted, so
against a `.env` carrying the Supabase values this route returns an object and
your subscribe path runs. Comment out `SUPABASE_URL` to get the `null` branch
back. **Nobody has yet watched a hint actually arrive in a browser** — the
server half is proven, the subscriber half is yours and still unverified.

A hint carries only `workspaceId`, `taskId`, `eventType`, and `eventId` — never
the payload. §5.1: "Assume channel messages can be forged by a link holder."
**Treat an arriving hint as "something changed, go refetch", never as data** and
never as a permission. A forged hint should at worst cause a wasted refetch.

Missed and duplicate hints are both normal. If your refetch is idempotent, you
have handled every case the transport can produce.

## Reviews

`GET /tasks/:t/reviews` → `{ reviews: Review[] }`, newest first. **Metadata
only.** `GET /reviews/:id` reads the candidate out of Git, and a `building`
review has no SHA to read, so a list of details would cost a Git read per row
and fail on the newest one. Pick the review you want, then fetch that detail.

`currentReview(reviews)` in `@app/contracts` is the one definition of which
review a screen should show — a live one (`building`/`ready`/`conflict`/
`stale`) if there is one, else the most recent `applied`. Use it rather than
re-deriving the rule.

**A review is requested, never automatic.** A task reaches `ready_for_review`
when its assignments integrate, and no review row exists until someone calls
`POST /tasks/:t/review`. An empty list therefore means "nobody has asked",
not "there are no changes".

That prepare call is a real mutation: it builds a Git candidate and answers
`INVALID_STATE` while a run is active, before every assignment has completed, or
from a completed/canceled task, and `INPUT_CONFLICT` when a selected material
has gone missing. Drive it from an explicit action only.

**Resolving a conflict creates a NEW candidate** (§10.2) — it never edits the
approved one in place. `candidateSha` changes, so anything holding the previous
one is stale. Both `POST /reviews/:id/resolve` and `POST /reviews/:id/apply`
name the SHA they expect, which is what stops a browser applying a candidate
that moved underneath it.

Conflict sides are `human_draft`, `agent_result`, `approved_main`, and
`combined_task`. §10.2 forbids labelling any of them "ours": the UI has to say
which source each one is.

---

## Agents

`GET /tasks/:t/agents` returns `{ attempts: TaskAttempt[] }`, newest attempt
first. Each attempt carries its `runId`, `attempt` number, run `status`, the
`taskVersion` it ran against, and its `assignments[]`.

Every attempt is returned, not just the latest. §4.7 requires an incomplete task
to show preserved output, so a retry must leave the failed attempt inspectable.

An assignment is `AssignmentProgress`: preset, status, `instructionSummary`,
`writePaths`, `dependsOn` (agent instance IDs within the same run), `baseSha`,
`resultSha`, `startedAt`, `deadlineAt`, `endedAt`.

- **`dependsOn` is a DAG, not an order.** Assignments whose prerequisites are
  all satisfied in the same wave can run simultaneously — that is what §4.5's
  "parallel workers are visibly distinct" is about, and a flat list hides it.
- **No token figures yet.** Absent rather than zero, because a zero reads as a
  measurement. The exhaustion state comes from an agent's `status`
  (`token_exhausted`), not from a count, so nothing is blocked. Requested from
  Role C in [their interface](role-c.md).
- **No model ID, provider setting, budget setting, or timeout control**, ever —
  §4.5. The response is schema-validated outbound, so that is enforced by shape
  rather than by discipline.
- **`deadlineAt` is display only.** It is fixed by the backend and never
  extended by waiting, retrying or replanning. Past it, the honest statement is
  that the deadline passed — whether the agent stopped is what `status` says.

An empty `attempts` array means nothing has been started, not that agents failed.

---

## Drafts

`GET /workspaces/:w/drafts` lists every **active** document in the workspace —
path, epoch, owning task, persisted revision. Added for the Files view, which
has to answer "what is being edited anywhere" and therefore cannot use the
per-task listing: that one needs the task ID it is trying to discover.

`GET /tasks/:t/drafts` is still the editor's file selector.

Both exclude closed epochs. Offering a closed document produces
`DOCUMENT_EPOCH_CLOSED` the moment someone opens it, so it is filtered at the
source rather than handled at the click.

`POST /drafts/open` is "Edit together" (§2.5) and is find-or-create: **200 means
you joined an existing editing session**, which is the normal outcome when two
people click the same file, not a collision to report.

---

## Still missing, and what it blocks

*Re-checked against `main` after C05 and C06 landed.*

| Needed | For | Owner |
|---|---|---|
| An approved-file **listing** (Git has `readText(path)` only — no tree op) | A07's Files view and the approved-file input picker (§2.1, §4.1) | D, then B |

`agentProgressSchema`, `applyReviewRequestSchema`, and
`applyReviewResponseSchema` are all already in `@app/contracts` with no route
behind them. The shapes are agreed; the endpoints are not built.

**The agents route now exists** — `GET /tasks/:t/agents`, see below. What
follows is why it took the shape it did.

**It was smaller than it looked.** Before C05/C06 there were no
assignments to serve; now every Start writes them. Everything §4.5 *requires* —
preset, status, instruction, write paths, dependencies, `startedAt`,
`deadlineAt` — is on `AgentInstance`, and `PgRunStore.listInstances(runId)`
already returns it from a Role B file. Only `tokensConsumed` / `tokenBudget`
need Role C's ledger, which has no read method, and §4.5 marks that display
optional. Address it **by task, not by run**: `TaskDetail.activeRunId` is null
once a run ends, and a finished attempt's assignments are exactly what someone
inspecting an `incomplete` task wants.

**History is built** — `GET /workspaces/:w/history`, see below. What follows is
the reasoning, kept because it explains the shape.

It was a smaller gap than it looked. The data model is already
there: `apply_operations` (migration 0002) carries workspace, review, candidate
SHA, status and settle time, and `src/runs/review-store.ts` already writes,
settles and reads it. Joining it to its review and task gives §4.1's "applied
changes and associated tasks" directly.

What is missing is a workspace-wide listing method, a route, and a contract
shape — all Role B, all in files Role B already owns. Nothing writes
`apply_operations` until owner apply (D07) exists, so the screen will correctly
show an empty list for now; that is a reason to build it cheaply, not a reason it
cannot be built. The `task.applied` event type is likewise declared in contracts
with no writer anywhere.

`GET /workspaces/:w/history` returns `{ entries: HistoryEntry[] }`, newest
first: the apply operation, its review, the task it came from, the commit, the
status, and when it settled.

**Non-applied outcomes are included.** A `failed`, `ambiguous`, or still
`pending` operation is part of what happened in the workspace, and §10.5 keeps
those states distinguishable precisely because they need different responses.
Listing only successes would make a stuck apply invisible in the one screen
meant to explain the past.

No changed-file list: naming paths means reading each candidate out of Git, one
read per row. The task and the commit are enough to find the detail, and the
review still holds it.

---

## Starting A05: what is and is not blocked

A05 splits cleanly in two, and only one half waits on anything.

**Buildable now.** Start is no longer inert (see *What a started run does now*
above): tasks move through real states and reach a terminal one on every path.
That makes all of these real, against endpoints that exist:

- Start / Stop / Retry and the answer flow — already shipped in A04, now against
  runs that actually execute.
- §4.7's error states, driven by the start-phase reason codes: `agent.waiting`
  with `payload.phase === 'start'`. `snapshot_conflict` and
  `integration_conflict` carry `payload.paths[]`; `context_captured` carries
  `payload.omitted[]`, which is worth surfacing — it is the only signal that a
  selected input silently did not reach the model.
- Deadline and waiting states, from task status plus `agent.waiting` /
  `agent.timed_out` / `agent.token_exhausted` events.
- Per-agent *lifecycle* awareness from `agent.started` / `agent.completed` /
  `agent.failed`, which carry `{ agentId }` and a `code` or `result`.

**Blocked on one route.** §4.5's assignment rows — the preset, instruction
summary, dependency graph, per-assignment state, output files, and the
"parallel workers are visibly distinct" requirement. Events name an `agentId`
and nothing else about it, so there is no way to label a row. See the note
above: this is a small Role B read route over an existing method.

Practical consequence for planning: build the run-lifecycle half of A05 first.
It needs nothing new, and it is what a demo actually shows — a task that starts,
works, asks a question, and finishes. The assignment graph is the part that
needs someone to add the endpoint.

---

## Tasks

`GET /tasks` returns board summaries with `materialCount` and
`openQuestionCount`. `GET /tasks/:t` returns the detail including `inputs[]`.

`PATCH /tasks/:t` requires `expectedVersion`. A 409 here is normal, not an
error state to hide — refetch and re-apply.

Task status drives board placement; the legal transitions are in design §2.4.
Dragging a card cannot change status.

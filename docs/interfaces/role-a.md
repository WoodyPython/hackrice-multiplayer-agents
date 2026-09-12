# For Role A — calling the API

**Reflects:** B05 · **Owner:** Role B

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

## Tasks

`GET /tasks` returns board summaries with `materialCount` and
`openQuestionCount`. `GET /tasks/:t` returns the detail including `inputs[]`.

`PATCH /tasks/:t` requires `expectedVersion`. A 409 here is normal, not an
error state to hide — refetch and re-apply.

Task status drives board placement; the legal transitions are in design §2.4.
Dragging a card cannot change status.

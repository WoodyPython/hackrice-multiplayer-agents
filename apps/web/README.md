# Workspace frontend — A01 / A02

Install from the **repository root** and run the API and frontend in separate terminals:

```sh
npm install
npm run db:up
npm run db:migrate
npm run dev
# In another terminal, also at the repository root:
npm run dev --workspace @app/web
```

Open http://127.0.0.1:5173. Vite proxies `/api` to the local API on port 3000;
the preview server uses the same proxy. For another backend port, update the
frontend proxy target. Production hosting must route `/api` to the Node service
and serve the SPA for `/w/*`; deployment is owned by Role D.

## A02 real workspace flow

- `/` creates a workspace with a name and optional purpose.
- `/w/:workspaceId` opens a contribution link directly, including after reload.
  No name prompt, invitation acceptance, account, or public workspace directory.
- The creating browser stores the one-time owner key per workspace. Only
  workspace metadata reads (to obtain server-confirmed `isOwner`) and owner
  updates carry `x-owner-key`. No secret enters a link, form body, identity,
  cursor payload, error text, or log.
- Copy workspace link builds a clean URL from the current frontend origin and
  validated ID. Clipboard rejection reveals a selectable link instead.
- `/w/:workspaceId/settings` edits name, purpose, and guidance for owners.
  Contributors can read guidance. Missing/rejected keys remove owner controls;
  settings text remains visible after save failures. Clearing browser storage
  loses owner access, with no ownership recovery flow.
- The header name control updates a browser-local contributor label while
  retaining its random contributor ID. Names are trimmed, nonblank, at most 80
  characters, and rendered as text. Previous contribution labels stay unchanged.
- Creation checks storage before contacting the API. If storage fails after
  creation, the key stays in this tab's memory with an explicit retry-save notice;
  reloading before saving can lose it. A name can still be used in memory when
  storage is blocked, with a visible persistence notice.

Task posting, discussion, files, history, editor, and review remain later-ticket
integrations. Real workspaces do not show or submit sample tasks. No agent is
started by creation or posting in the sample.

## A01 sample

Select **Explore the sample workspace** on `/` to open `/demo/w/:workspaceId`.
This retains the schema-validated task board, inert local posting, task detail,
requirements, and empty/loading/error preview controls. Reload resets demo tasks.
All ten `TASK_STATUSES` map to the five design section 4.3 columns. Canceled
tasks remain under Needs attention; dragging cannot change status. Demo posting
uses the current guest label, and later name changes do not rewrite old cards.

## A03 cursor integration

See [the A02 browser interface](../../docs/interfaces/role-a-browser.md) for the
session hook and `bindGuestAwareness`. It publishes the current label immediately
and on renames, without reconnecting or changing identity. A03 attaches it to
the active document's `provider.awareness`; A02 does not create a document room
or a participant directory.

## Verification

```sh
npm run build
npm run typecheck
npm test
npm test --workspace @app/web
```

Frontend tests cover both A01 and A02, including creation double-clicks, owner
key isolation, storage failures, direct entry, permission loss, settings saves,
guest persistence, cross-tab names, and awareness updates. Browser visual QA
still requires a browser-enabled session.

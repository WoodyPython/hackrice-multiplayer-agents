# Workspace frontend - A01 / A02 / A03

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

Task posting, discussion, files, history, and review remain later-ticket
integrations. Real workspaces do not show or submit sample tasks. No agent is
started by creation or posting in the sample.

## A01 sample

Select **Explore the sample workspace** on `/` to open `/demo/w/:workspaceId`.
This retains the schema-validated task board, inert local posting, task detail,
requirements, and empty/loading/error preview controls. Reload resets demo tasks.
All ten `TASK_STATUSES` map to the five design section 4.3 columns. Canceled
tasks remain under Needs attention; dragging cannot change status. Demo posting
uses the current guest label, and later name changes do not rewrite old cards.

## Guest cursor integration

See [the A02 browser interface](../../docs/interfaces/role-a-browser.md) for the
session hook and `bindGuestAwareness`. It publishes the current label immediately
and on renames, without reconnecting or changing identity. A03 attaches it to
the active document's awareness; there is no participant directory.

## Design system

The interface is CoFlow: deep navy on a warm off-white ground, taken from the
wordmark. Everything visual is driven from one place — `src/styles.css`.

- **Tokens.** `@theme` defines the brand ramp (`--color-navy-*`), a neutral ramp
  cooled toward the navy (`--color-ink-*`), and semantic surfaces
  (`--color-background`, `--color-card`, `--color-primary`, `--color-border`,
  `--color-ring`, …). The names follow the shadcn/ui convention, so a component
  written against that vocabulary — the 21st.dev catalogue included — drops in
  without translating class names. Use the semantic token, not the raw ramp,
  unless you are deliberately reaching for the brand colour.
- **Dark mode.** A `data-theme` attribute on `<html>` redefines the semantic
  tokens; nothing else changes. `index.html` stamps the stored choice before
  first paint so there is no flash, and `src/theme.ts` owns reading, resolving
  and persisting it. A component that only uses semantic tokens needs no `dark:`
  variants at all.
- **Primitives.** `src/components/ui/` holds `Button`/`ButtonLink`, `Card`,
  `Badge`/`Dot`, the form controls (`Input`, `Textarea`, `Select`, `Label`,
  `Checkbox`), and `Skeleton`/`Notice`/`Path`/`Avatar`/`Eyebrow`. Prefer these
  over ad-hoc Tailwind on a bare element, so focus rings, disabled states and
  dark mode stay consistent.
- **State colour is data, not a class name.** `src/board.ts` maps every status —
  tasks, attempts, assignments, reviews, apply operations — to a `Tone`, and
  badges and dots take that tone. Never build a class out of a status string: a
  status the API adds later then renders neutral rather than unstyled.
- **Chrome.** `AppShell` owns the sidebar, the mobile slide-over, the sticky
  topbar and the `#main` landmark. The live workspace and the fixture demo both
  render through it, so the two cannot drift apart.
- **Icons** come from `lucide-react` and are always `aria-hidden`; the
  accessible name is the adjacent text.

Tailwind v4 runs through `@tailwindcss/vite` with no config file — the tokens in
`styles.css` are the configuration. Hand-written CSS is limited to what
utilities cannot reach: the Monaco frame, the Markdown preview (`.cf-prose`),
remote-cursor styling, and the scrollbar treatment.

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

## A03 shared editor

Open `/w/:workspaceId/tasks/:taskId/drafts` for an existing task with active
B05 drafts. Share that address to edit the same document in another browser.
The document selector reads the existing drafts API; creating tasks and opening
manual-edit drafts from Files remain A04/A07.

Monaco binds the server-initialized Yjs `content` text and awareness cursors.
Markdown preview does not execute raw HTML or load external images. Saved means
the server has acknowledged durable persistence, not merely received an update.
Keep the tab open while offline: reconnection merges its retained document.
Closed/rejected documents stop reconnecting and expose text for recovery.
Vite proxies `/live` WebSockets; production must route `/live` to the same Node
runtime as `/api`. Monaco and its worker are bundled locally, with no CDN.

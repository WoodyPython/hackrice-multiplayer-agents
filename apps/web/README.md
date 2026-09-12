# A01 workspace shell

React, TypeScript, and Vite. Install from the **repository root**:

```sh
npm install
npm run dev --workspace @app/web
```

Open the Vite URL (normally http://127.0.0.1:5173) and select **Explore the
sample workspace**. The root `npm run dev` still starts the server.

This is a fixture-backed preview. Posting validates with `postTaskRequestSchema`,
creates a local `TaskDetail` in `posted` state, and opens Discussion. Reloading
resets changes. No API requests, agent starts, owner keys, or persistence are
implemented in A01. Start is shown disabled only for eligible tasks.

All ten `TASK_STATUSES` appear in the five design section 4.3 columns. Canceled
tasks remain under Needs attention because they support manual retry; they do
not appear completed. Cards cannot be dragged to change status. Assignment
summaries are sample presentation copy, not an API field or live progress.

Routes follow design section 4.1. `/` introduces the sample workspace;
`/w/:workspaceId`, `/tasks/:taskId`, `/files`, `/history`, and `/settings` render
the shell. `/w/:workspaceId/tasks/new` is the requirements form. Unknown links
show a missing-resource page. File/history/settings screens are placeholders
for later tickets, as are the Discussion/Drafts/Agents/Changes tabs.

Use **Preview state** to inspect sample, empty, loading, and retryable load-error
states. The query string preserves the selected state across reloads. Mobile
navigation stacks above content; the five-column board scrolls horizontally.

```sh
npm run build
npm run typecheck
npm test
# Frontend-only checks, no PostgreSQL required:
npm test --workspace @app/web
```

Tests cover schema-valid fixtures, status placement, filtering, validated
posting, selected inputs, direct routes, keyboard tabs, navigation, and preview
state recovery. Shared contracts and backend code remain owned by their roles.

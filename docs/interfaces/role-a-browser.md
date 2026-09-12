# A02 browser session and workspace entry

**Reflects:** A02 · **Owner:** Role A

For A03/A04 consumers. Shared HTTP shapes remain in `@app/contracts`; A02 changes
no backend contract.

`apps/web/src/browser-context.tsx` exposes `useBrowser()` and `useGuest()`.
`useGuest()` reacts to the current tab's edits and browser storage events. Its
display-only `{ contributorId, name, color }` contains no owner key. Use the name
at submission time for subsequent contributions; do not rewrite saved labels.
The contributor ID is stable across edits and reloads while storage remains.

When opening an editor, bind its existing awareness object:

```ts
import { bindGuestAwareness } from '../../session';

const dispose = bindGuestAwareness(provider.awareness, session);
// On document close / provider replacement:
dispose();
```

Use the actual relative import for the consuming file. This sets the standard
`user` awareness field to `{ id, name, color }` immediately and when a name
changes, leaving cursor and selection fields alone. Disposal removes the user
field and subscription. It does not open a connection, enumerate participants,
or broadcast owner keys. D03/A03 still own document transport/editor integration.

`WorkspaceApi` owns same-origin workspace create/read/update calls. It persists
the one-time creation key before returning only the workspace ID to the UI.
Workspace metadata reads send the workspace's local key solely to resolve
server `isOwner`; settings writes send it in `x-owner-key`. Do not attach this
key to task contributions, URLs, awareness, or a global fetch default. `isOwner`
is never derived from contributor identity or a local ownership flag.

`BrowserSession` checks storage before creation. If the subsequent owner-key
write fails, it holds the returned key in memory and the UI offers retry-saving
that same key. This is not ownership recovery and never creates a second
workspace. Successfully stored owner keys are read afresh, so storage clearing
removes access. Focus/storage events trigger permission revalidation.

The sample lives at `/demo/w/*`. Real `/w/*` routes never substitute fixture
data for missing or unavailable resources. Workspace IDs are normalized to
lowercase at route entry. Sharing constructs `/w/:id` on the current frontend
origin without copying query strings or fragments.

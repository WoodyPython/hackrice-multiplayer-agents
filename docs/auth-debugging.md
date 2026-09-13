# Authentication investigation — September 13, 2026

## Fixed failures

- **Repeated startup requests:** `AuthProvider` recreated its default API client on every render. The client is now stable, and older requests cannot overwrite a completed login or logout.
- **False logout and failed logout:** temporary session-read failures no longer clear the account. Startup offers retry; failed logout keeps the account visible and reports the failure.
- **Missing sign-out:** account controls now appear on workspace and creation screens. A wrong-account invitation offers sign-out and preserves the invitation destination for the next login.
- **Owner controls disappeared:** account membership, confirmed by the server, replaces the obsolete requirement for a browser-stored owner key. Workspace permissions reload when the account changes; rejected settings writes remove owner controls.
- **Stale workspace membership:** creation refreshes the account's workspace list. Successful create, claim, and invitation mutations remain successful even if the following session refresh fails.
- **Invitation dead ends:** temporary preview and acceptance failures can be retried. Changing the invitation or account clears stale preview errors, and preview waits for initial session loading.
- **Existing passwords rejected by the browser:** minimum length is enforced on signup, not sign-in. Redirect destinations reject external and backslash paths.
- **Local auth configuration not loaded:** Vite now loads the repository-root `.env`, matching the documented setup.
- **Production auth deep links returned 404:** the server now serves the SPA for `/signin` and `/invite/*` as well as workspace routes.
- **Malformed cookies caused 500s:** invalid percent encoding is treated as an invalid session.
- **HEAD permission mismatch:** automatic HEAD routes inherit the corresponding GET permission requirements.
- **Provider failures caused crashes or stalls:** malformed Supabase responses produce auth errors and verification has a bounded timeout.
- **Cookie expired despite server renewal:** session reads renew the browser cookie to match the database session expiry.
- **Concurrent owner edits could deadlock:** roster changes serialize on the workspace before locking individual members, preserving at least one owner.
- **Open editors retained revoked write access:** each document update rechecks session validity and workspace membership inside the existing ordered update queue. Logout, expiry, and membership removal reject the next edit without persisting it.

## Verification scope and limits

The final frontend suite passes all 158 tests across 14 files. The complete server run exercised 824 tests: 821 passed, with only the three stale budget fixtures below failing. After fixing those fixtures, the review-assessment and frontend-hosting rerun passed all 21 tests. The final server unit run passed 136 tests, including production auth deep links. No test failures remain unresolved; the entire 18-minute server suite was not repeated after the fixture-only correction.

The final production build and workspace type checks pass. Vite still reports large editor chunks; this is a build warning, not a build failure.

The broader server run also exposed three stale review-assessment tests: an earlier increase in the global token budget meant one reservation no longer exhausted the budget. Their fixtures now explicitly fund one request and still verify that unknown provider usage cannot release reserved tokens. Production budget accounting was not changed.

Tests use a dedicated local `app_test` PostgreSQL database. The runtime walkthrough covers session exchange, workspace creation, shared draft edits, material upload, simulated parallel agents, review, apply, and restart. Provider responses and model calls are simulated; database, HTTP, WebSocket, and Git behavior are exercised locally.

The browser automation tool reported no available browser, so no visual browser walkthrough was completed. The local `.env` also lacks `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`; real provider login and email confirmation remain unverified. Supply the matching public URL/key pairs using `.env.example`, and rebuild after changing Vite variables. Never put a Supabase secret or service-role key in a `VITE_` variable.

Changes are local source changes; they have not been deployed.

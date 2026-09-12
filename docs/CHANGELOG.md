# Changelog

Newest first. One entry per landed ticket.

## A05 — Execution and agent progress
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Pull and `npm run build` (the contracts package gained
schemas). Role C: one optional request in [your interface](interfaces/role-c.md).

- **New route, `GET /tasks/:t/agents`** (Role B, `src/tasks/routes.ts` over
  `PgRunStore.listAttemptsForTask`). Returns every attempt newest-first with its
  assignments. Every attempt, not just the latest: §4.7 requires an incomplete
  task to show preserved output, so a retry must leave the failed attempt
  inspectable. Task-scoped, not run-scoped, because `activeRunId` is null once a
  run ends.
- **Agents tab** renders assignments in **dependency waves**. §4.5's "parallel
  workers are visibly distinct" is a property of the graph; a flat list shows
  the same data and hides the fact. Assignments sharing a wave genuinely can run
  at once.
- **Run outcomes are explained**, using C06's start-phase reason codes
  (`agent.waiting` with `payload.phase === 'start'`). Each known code maps to a
  sentence this repo owns; an unknown one still renders an explanation, because
  the interface notes say the codes are stable but the set is not closed.
  `payload.omitted[]` is surfaced prominently — it lists selected inputs that
  could not be captured, and without it a contributor believes the agents read a
  document they never saw.
- **Polling adapts**: 2s while an attempt is live, 5s otherwise. §5 makes
  polling authoritative and realtime a latency optimisation, so this is a
  comfort setting. 5s was too coarse for a run — planning → working →
  needs_input can happen inside one tick and the screen looks stuck.
- **Deadline display** is derived from `deadlineAt` for running agents only, and
  past zero says the deadline passed rather than that the agent stopped. Those
  are different, and only `status` knows the second.

**Deliberately not built:**

- **Token figures are absent, not zero.** The ledger has no read method; a zero
  would read as a measurement rather than a missing one. §4.5 marks the display
  optional and §4.7's exhaustion state comes from agent `status`, so nothing is
  blocked. Requested from Role C.
- The response is **schema-validated outbound**, which makes the schema a
  whitelist: a column added to `agent_instances` later cannot reach the browser
  by accident. Do not replace that parse with a cast.
- `agentProgressSchema` is untouched; `assignmentProgressSchema` is a sibling.
  The contracts package is additive-only, and the token fields on the original
  are required.

Verified: `npm run build`, the full web suite (**45 tests**, up from 38), and the
backend suites this touches — `runs`, `tasks`, `drafts`, `events` (**106**, with
`runs` up from 27 to 33). The full backend suite was **not** run: nothing here
reaches the Git or orchestration suites, and `git-integration.test.ts` alone now
costs 17 minutes (see the previous entry — it also has a failing test that needs
Role C or D).

Four properties were mutation-checked by breaking them until the test failed:
the dependency-wave layout, the omitted-inputs panel, instruction summarisation,
and workspace scoping on the new route.

---

## Docs — A05 re-scoped against C05/C06, and the agents gap narrowed
**Landed:** 2026-09-12 · Role A
**Affects:** whoever starts A05, and whoever adds the agents route
**Action required:** None. Read *Starting A05* in
[the Role A interface](interfaces/role-a.md#starting-a05-what-is-and-is-not-blocked)
before picking up A05.

C05 and C06 landed for real (`98c6f14`, `b88eac7`), so the frontend's picture of
execution changed and the documents said otherwise. Re-checked against `main`:

- **Start is no longer inert.** `recovery/runtime.ts` assembles the real
  `StartOrchestrator`; `buildApp` still defaults to `NullOrchestrationHook`,
  which is why tasks move under `npm run dev` and not under `buildTestApp`.
- **A05 splits in two, and only one half is blocked.** The run-lifecycle half —
  start/stop/retry, answering, §4.7's error states — is buildable today against
  endpoints that exist, using C06's start-phase reason codes (`agent.waiting`
  with `payload.phase === 'start'`). Build that first: it is what a demo shows.
- **§4.5's assignment rows are still blocked on one route**, but a much smaller
  one than before. Everything that section *requires* is on `AgentInstance`, and
  `PgRunStore.listInstances(runId)` already returns it from a Role B file. Only
  token usage needs Role C's ledger, and §4.5 marks that optional. Address the
  route by **task**, not by run: `activeRunId` is null once a run ends, and a
  finished attempt's assignments are what someone inspecting an `incomplete`
  task wants to see.
- Design §4.5 amended to say this rather than the flat "no data source yet" it
  carried while orchestration did not exist.
- `context_captured` carries `payload.omitted[]` — selections that could not be
  captured. Worth surfacing in A05: it is the only signal that a selected input
  silently did not reach the model.

Also corrected: [`handoff-b08.md`](handoff-b08.md) said C05 was a phantom. It
was, for about an hour — `6950fc3` added only an npm script pointing at a
missing vitest config. The real scheduler landed in `98c6f14`. The note is kept,
because the lesson holds: a commit message is not evidence a ticket landed.

**B08 now waits on exactly two tickets, C07 and D07, and they are independent.**
Both are unblocked today, so they can run in parallel.

Verified on merged `main`: `npm run build` passes. The full suite was **not**
re-run to completion for this docs-only change — but a partial run surfaced
something the team should own:

**`git-integration.test.ts` is now pathological, and one test in it fails.**
`D05 worker integration > preserves refs and guard errors when cancellation
rejects prepared fast-forward, merge, or no-op results` ran for **487 seconds**
and failed; the file as a whole took **17 minutes**. That is most of why a full
run now costs a quarter of an hour. It is Role D's test and C05 modified it
(`98c6f14` touched this file), so it needs one of them rather than a guess from
here. Not a new flake class — `pitfalls.md` already records that an intermittent
failure with no assertion message is a timeout until proven otherwise — but the
scale is new and worth treating as a defect rather than a slow test.

---

## C07 — Reviewer, evidence, and review handoff
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, C, and D
**Action required:** `registerReviewRoutes` now takes a required third argument; rebuild and see the interface note below if anything calls it directly. Two additive routes: `GET .../reviews/:reviewId/evidence` and `POST .../reviews/:reviewId/assess`. Read [C07 integration notes](../apps/server/src/orchestration/REVIEW.md). No migration or dependency is added.

- `ReviewAssessor` runs one fresh reviewer-preset pass against a review's own
  current candidate (design section 10.4), deliberately decoupled from
  `PgAgentLedger`/`agent_instances`: those are gated on the task's active run,
  which a review no longer has by the time anyone asks to assess it. It
  reserves and settles against the same `task_agent_budgets` table under a
  dedicated `review:<reviewId>` key, records its result as a durable
  `review.assessed` event, and is idempotent per exact candidate SHA — a
  repeat request against the same candidate is read back, never re-run.
- `ReviewEvidenceComposer` composes `ReviewEvidence` from durable data alone —
  no new table. In-run `agent.completed` summaries are labeled against the run's
  own examined SHA and flagged stale the moment the review's source tuple
  diverges from what that run actually captured; fresh assessments are folded
  in and re-flagged stale once a later resolution produces a new candidate.
  `validationsPerformed` are checks the server actually ran, not a model's claim.
- Two of design section 16.3's four C07 bullets were already delivered by
  earlier tickets and needed no new code: "ready/incomplete results" by C06's
  `StartOrchestrator.finish()`, and the "request-revision handoff" mechanism by
  B03's existing `planning`-from-`ready_for_review`/`conflict` transition plus
  ordinary discussion posting, which C06's capture already reads into the next
  attempt. See the interface note for why no new route was added for either.
- Verified: full build; `npm run test:review` passes all 14 checks against
  real PostgreSQL, including budget exhaustion, a retried provider error
  charging both attempts, in-process coalescing, staleness in both directions,
  and the two new HTTP routes.

## C06 — Explicit Start and captured context
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, B, C, and D
**Action required:** Start now executes. A run reaches a terminal state on every path, so A05 can drive progress from run/task status and the `run:<runId>:start:*` events. C07 picks up `ready_for_review` runs with a recorded `result_head_sha`. The runtime builds the whole Role C stack; do not construct a second scheduler, ledger or executor against one data root. Read [C06 integration notes](../apps/server/src/orchestration/START.md). No migration or dependency is added.

- `StartOrchestrator` implements the B03 `OrchestrationHook`: it captures the
  context manifest, creates the planning instance, runs C03 planning and C05
  dispatch, and terminalizes the run. It never throws into Start, never
  re-triggers on a replay, and leaves a previous boot's run untouched.
- Capture unions explicitly selected inputs with materials attached directly to
  the task (section 3.3), stops discussion at the run's cutoff, and reads
  approved files at the recorded main commit and drafts at the D04 checkpoint.
  Selections that cannot be captured are reported in the capture event rather
  than captured as empty text.
- Additive Git capability `LocalGitService.combineStartSnapshot` implements
  section 8.4's start snapshot. A conflicting combination ends the run before
  any model call, with the task in `conflict` and the affected paths recorded.
  The three-way merge core is now shared with D05's integration path.
- `PgRunStore.settle` takes an optional task status and terminalizes leftover
  assignments, so a run and its task settle in one transaction. Existing callers
  are unaffected. Run/task/agent finalization has one writer.
- Failure reasons are stable codes, never provider or filesystem text.
- The runtime assembles ledger, adapter, planner, scheduler, worker executor and
  orchestrator as per-process singletons, starts the deadline sweep, and stops
  dispatch first on shutdown. Without `GEMINI_API_KEY` the process still serves
  everything else and reports `model_configuration` per Start.
- Verified: full build; `npm run test:start` passes all 8 checks against real
  PostgreSQL and a real repository, including a genuinely diverged main combined
  into one snapshot, and a conflicting one refused before any model call.

## C05 — Parallel assignment scheduler
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, B, C, and D
**Action required:** C06 injects the singleton scheduler/executor and LocalGitService, supplies captured context, and owns durable cancellation/run finalization. D05's real merge is now connected through a guarded capability. Read [C05 integration notes](../apps/server/src/orchestration/SCHEDULER.md). No migration or dependency is added by C05.

- Loads/revalidates the saved plan, creates stable worker instances and complete
  dependency graphs, and dispatches independent workers without a global cap.
- Persists bases and integration receipts, serializes workspace integrations,
  and releases dependents only after successful integration. Conflicts/failures
  retain checkpoints and let independent peers finish.
- Synced upstream through `cb2fe1f` (including D05 `d18cb4d`) and connected D05's
  real merge with exact-source/scope checks and a guard immediately before
  result publication. Isolated callers without D05 keep pending results.
- Adds durable provider backoff/resume events on the existing fixed clock and
  budget. No HTTP Start wiring or frontend progress work is included.
- Focused checks cover concurrency, graph gating, conflicts, failures, stale
  publication, duplicate dispatch, and real parallel C04/D05 merges with
  dependent output reads. Guard checks preserve main/human/worker refs.
- Validation after syncing D05: full build and suite passed with 537 backend
  and 27 frontend tests. The focused scheduler suite also passed all 19 checks.

## Docs — design document amended to match what was built
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. Documentation only; no code.
**Action required:** None. Read the §4.3 note before touching board card copy.

The design document is the specification and wins where anything disagrees with
it, so these are amendments rather than notes filed elsewhere:

- **§4.1 — the editor route.** The table said
  `/w/:w/tasks/:t/edit/:fileId`; A03 shipped `/w/:w/tasks/:t/drafts` with an
  in-page file selector. §4.4 already requires a selector as a control, so a
  per-file route duplicates it and forces a navigation that remounts the Yjs
  binding. The table now matches the implementation.
- **§4.1 — History's data source** is named: `apply_operations` joined to its
  review and task. Empty until D07 writes to it, which makes an empty History a
  correct answer rather than a missing feature.
- **§4.3 — board cards may no longer claim agent activity.** The old wording
  asked for a "current assignment summary" that `TaskSummary` does not carry;
  the first implementation satisfied it with per-status copy, so every working
  task claimed a "Writer" was "preparing a first draft" whether or not such an
  agent existed. That is the fake progress §4.7 forbids.
- **§2.1 — approved files are not selectable** in the input picker, because
  nothing can enumerate them: the Git service has `readText(path)` and no tree
  operation.
- **§4.5 — agent progress has no data source.** `AgentProgress` is fully
  specified in contracts and served by no route; events carry only `{agentId}`.
  Separate from orchestration being absent.
- **§4.6 — review has no read path.** `reviewId` is not on the task detail
  shape and the only way to obtain one is `POST /tasks/:t/review`, a mutation.
  There is no apply route at all.

Also corrected: an earlier note in [the Role A interface](interfaces/role-a.md)
called History possibly unbuildable. That was wrong — `apply_operations` and its
store already exist, and what is missing is a listing method, a route, and a
contract, all in Role B files. It is a small ticket, not a blocked one.

[`handoff-b08.md`](handoff-b08.md)'s status table is updated: **D07 is unblocked
now**, and **C05 is not implemented** despite `6950fc3 "Add C05"` — that commit
adds one npm script pointing at a vitest config that does not exist, with no
scheduler behind it. C06 depends on C05, so anyone planning around it should
confirm first.

---

## A04 — Task posting, discussion, and materials (plus the unblocked half of A07)
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Pull and `npm run build`. Roles C and D: three endpoints the
frontend needs do not exist — see **Blocked on** below and
[the Role A interface](interfaces/role-a.md#still-missing-and-what-it-blocks).

- **The live workspace was still a placeholder.** A01 built the board, task
  detail, and requirement form against `fixtures.ts` and mounted them only at
  `/demo`; every real route (`/w/:id`, `/files`, `/history`, `/tasks/*`) rendered
  "coming next", and `workspace-api.ts` could only talk about workspaces. All of
  them are now live.
- **Post, revise, discuss, attach, start, stop, retry.** Requirements use §2.1's
  optimistic version check; a 409 keeps what you typed and refetches rather than
  discarding the edit. Every state-changing call carries a `clientRequestId`
  created once per user intent and reused on retry.
- **Agent questions route through `/answer`, not `/discussion`.** §2.6 makes a
  question a record, not a formatted comment. The same words posted as a comment
  would land above the run's discussion cutoff and reach no agent — identical
  text, silently doing nothing. There is a test asserting the endpoint, because
  this is invisible in the rendered output.
- **Entries above the active cutoff are labelled "Added after this run
  started"** (§2.3), and the compose box says plainly that a running attempt
  will not read what you are typing.
- **Files** (§4.1, the A07 half that is not blocked): reference-material upload
  with §3.4's text-only rule stated in the picker, active shared drafts across
  the workspace, and Edit together.
- **Fixed: the board invented agent progress.** `board.ts` hardcoded
  `working → "Writer · preparing a first draft"` and rendered it on every
  working card regardless of what was running, or whether anything was.
  `TaskSummary` carries no assignment summary, so §4.7's "avoid fake progress"
  rules that out. Copy is now state-derived and claims nothing about agents.
- **New:** `GET /api/workspaces/:w/drafts` (Role B, `src/drafts`) lists active
  documents workspace-wide. The Files view cannot use the per-task listing — it
  needs the task ID it is trying to discover.
- `/demo` still works and no longer shares fixture data with live code:
  `RequirementForm` and `TaskDetail` take their options and tab bodies as props
  instead of importing `fixtures.ts`, which is why the live form previously
  offered three material IDs that existed in no real workspace.

**Blocked on, and stated in the UI rather than faked:**

- **Agents tab** — C06 supplies the orchestration hook (`buildApp` still
  defaults to `NullOrchestrationHook`, so Start records an attempt and runs
  nothing), *and* no route serves `AgentProgress`. Both are needed; the schema
  already exists.
- **Changes tab** — C07 and D07. No apply route exists, and nothing exposes a
  task's review ID.
- **Approved files** — nothing in the system can enumerate main; the Git service
  has `readText(path)` and no tree operation. The section says "not available
  yet" rather than showing an empty list, which would claim the workspace has
  approved nothing.
- **History** — §4.1 specifies the screen and no data source exists for it.

**Two divergences from the design document, for the team to rule on:**

1. §4.1 specifies the editor at `/w/:w/tasks/:t/edit/:fileId`. A03 shipped
   `/w/:w/tasks/:t/drafts` with an in-page file selector. The implementation
   looks better — §4.4 requires a file selector as a control, so a per-file
   route duplicates it — but the document still says otherwise, and by our own
   rule the document wins until amended.
2. §4.1's History screen may not be buildable as specified without a new
   endpoint nobody owns.

Verified: `npm run build` and `npm test` — **547 backend + 38 frontend** (544 + 27 before this: three for the new route, eleven for the frontend flows). The three
frontend properties that cannot be seen in rendered output (answer routing,
idempotency-key reuse, no fabricated progress) and the new route's workspace
scoping were each confirmed by mutating the code until the test failed.

---

## Fix — Supabase storage and realtime verified against a live project
**Landed:** 2026-09-12 · Role B
**Affects:** anyone running against Supabase; Role A (realtime is now advertised)
**Action required:** Pull if your `.env` points at a Supabase project. Local-disk
runs are unaffected — the bug was in the Supabase implementation only.

- **Both integrations are verified.** `npm run supabase:smoke --workspace
  @app/server` passes all four checks against a live project. B04 storage and
  B06 realtime are no longer unverified, and the notes saying so are gone from
  `blob-store.ts`.
- **`SupabaseBlobStore` could not recognise a missing object.** Supabase Storage
  answers a GET for an absent object with **HTTP 400**, not 404, and puts the
  status it means inside the body (`"statusCode":"404"`, `"code":"NoSuchKey"`).
  `get` mapped only a real 404 to `null` and threw on everything else, so the
  `null` branch of `BlobStore.get` had never once run against the implementation
  that ships. `delete` had the same hole, which would have turned the upload
  path's lost-dedupe-race rollback into a second error.
  *What it would have cost:* `readSelected` exists to turn a missing object into
  `MATERIAL_NOT_FOUND` rather than feed an empty file to a model. Without this it
  would have been a 500 the first time an object actually went missing.
- Classification is by the body's `code`, never the status: `NoSuchBucket` and
  `AccessDenied` also arrive as 400, so mapping the status class to `null` would
  have converted a mistyped `SUPABASE_STORAGE_BUCKET` into "every material is
  missing" — indistinguishable from an empty store. Six tests cover the recorded
  response shapes; each was checked by mutating the fix until it failed.
- Verified end-to-end against the hosted project, not only by the smoke script:
  workspace creation, `realtime` advertised as an object, upload and
  byte-identical read back through the API, and a row whose object was removed
  from the bucket answering 404 `MATERIAL_NOT_FOUND`. Test rows were removed
  afterwards.
- Docs: a [`pitfalls.md`](pitfalls.md) entry, and the failure table in
  [`supabase-setup.md`](supabase-setup.md) corrected — it promised 404/401/403
  and this project answers 400 for all three.

Verified: `npm run build` and `npm test` — **502 backend + 23 frontend**, all
passing (496 backend before this; the six new tests are the classification
checks). The known `git-files.test.ts` flake did not fire on this run.

---

## D06 - Combined review candidates
**Implemented:** 2026-09-12 - local main worktree (commit pending) - Role D
**Affects:** Roles A, C, and D
**Action required:** Rebuild `@app/contracts` and read the
[D06 review contract](interfaces/git.md#combined-review-candidates-d06).
Resolution uses `resolveCandidateRequestSchema` with `expectedCandidateSha`;
second-stage conflicts expose `combined_task` versus `approved_main`.
No migration or new dependency is required.

- Two-stage human/agent/approved combination in temporary review worktrees,
  with private immutable candidates and exact persisted source/context records.
- Contributor prepare/resolve routes and scoped review, diff, and text-preview
  reads; real changed-file data and explicit conflict source labels.
- Whole-file/manual/deletion resolutions, portable namespace conflicts, and
  new commits per resolution round. Old candidates and source branches survive.
- Atomic candidate/status/task/event finalization, existing D04 live capture,
  runtime wiring, and focused Git, database, HTTP, and two-client tests.
- Apply, continuous staleness invalidation, AI assessment/revision dispatch,
  epoch closure, and workflow restart reconciliation remain later tickets.

Verified: workspace build, `git diff --check`, and the full suite passed:
538 backend tests and 27 frontend tests, including 23 D06 Git/API checks.
The new live-capture check uses two real WebSocket clients; no frontend UI was
added or manually exercised by this ticket.

---

## A03 - Simultaneous editor binding
**Landed:** 2026-09-12 - Role A
**Affects:** Role A; A04/A07 can link to shared task drafts
**Action required:** Run `npm install`. Production must proxy `/live` WebSockets to the Node runtime; Vite development and preview already do so. No migration.

- Added `/w/:workspaceId/tasks/:taskId/drafts`, active-document selection,
  Monaco/Yjs binding, shared cursors with live guest renames, and inert Markdown preview.
- Server persistence acknowledgements drive Saved; queued writes and offline
  edits remain unsaved. Reconnect retains the local Yjs document. Closed/rejected
  epochs stop reconnecting and expose recovery text.
- Task posting, file creation, execution, and review flows remain their own tickets.
- Verified: frontend production build/typecheck and 27 frontend tests, including
  two real WebSocket clients against D03 for convergence, awareness, persistence,
  and offline reconnect. No manual two-browser visual check was performed.

---
## Fix — restore `withDraftCapture`, wire Supabase storage, handoff docs
**Landed:** 2026-09-12 · Role B
**Affects:** everyone
**Action required:** Pull. `main` did not build before this.

- **`main` was broken.** Merge `5c483af` resolved a `git/service.ts` conflict
  between C04 and D04 by keeping C04's `applyGuardedWorkerChanges` and dropping
  D04's `withDraftCapture`, leaving its doc comment and every caller in place.
  Restored verbatim from `dde066a`; both methods now exist. Build and the full
  suite are green: **496 backend + 8 frontend**.
  *After any merge where two roles touched one file, build and test before
  pushing — a green branch plus a green branch is not a green merge.*
- **`SupabaseBlobStore` was never selected from configuration.** `buildApp`
  always fell back to local disk, and `config.ts` did not read
  `SUPABASE_STORAGE_BUCKET` despite `.env.example` documenting it. Setting the
  Supabase variables would have enabled broadcasting and silently not storage.
  Both are now chosen from config.
- `npm run supabase:smoke --workspace @app/server` verifies storage and realtime
  against a live project in one command. Both integrations remain **unverified**
  until someone runs it.
- New: [`supabase-setup.md`](supabase-setup.md) and
  [`handoff-b08.md`](handoff-b08.md).

---

## A02 — Guest workspace entry and browser owner controls
**Landed:** 2026-09-12 · `a1b704e` · Role A
**Affects:** Role A; A03/A04 consume the browser session
**Action required:** Run the API and `npm run dev --workspace @app/web` in separate terminals. A03 should bind its open document's awareness through `bindGuestAwareness`; A04 should take new contribution labels from `useGuest()`. See [the browser interface](interfaces/role-a-browser.md). No new dependency or migration.

- Real creation at `/`, direct entry at `/w/:workspaceId`, clean contribution
  links, and owner-only workspace name/purpose/guidance updates through B02.
- Owner keys remain browser-local and workspace-scoped; only metadata reads
  resolving `isOwner` and owner updates carry `x-owner-key`. Sharing reconstructs
  a clean frontend URL with no query, fragment, or secret.
- Editable, validated guest names retain their contributor ID and update the
  document-awareness binding immediately. Saved contribution labels stay intact.
  No accounts or participant directory; live editor/transport remains A03/D03.
- Handles blocked storage, a failed one-time key save, permission loss, missing
  workspaces, clipboard failure, and duplicate creation clicks. Failed settings
  saves preserve entered text. A01's fixtures now live under `/demo/w/*`.
- Verified for A02: 23 frontend tests, frontend production build/typecheck,
  and a local API smoke
  check through Vite covering creation, direct links, contributor rejection, and
  owner updates. Browser visual QA was unavailable in this session.

---

## D05 — Parallel worker-result integration
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles C and D
**Action required:** Rebuild `@app/contracts`. C05 should read
[the D05 integration contract](interfaces/git.md#worker-result-integration-d05),
especially ordered result-head recording, completed-worker authority, and the
requirement that prerequisites integrate before dependents start. No migration
or dependency is added.

- Serialized three-way integration into the existing result branch, with
  fast-forward and two-parent merge commits and guarded ref publication.
- Complete conflict paths from unresolved Git stages and portable namespace
  collisions; conflicts preserve the result, workers, human drafts, and main.
- Immutable base validation, whole-tree text checks, idempotent repeated/no-op
  integration, and preserved commits after result projection failures.
- Runtime schemas, focused Git tests, and C05 handoff documentation. Scheduler,
  metadata lifecycle, review, Apply, Yjs, and restart orchestration are unchanged.

Verified after reconciling `origin/main` at `9c14b3a`: `npm run build`, all 44
focused D04 capture/D05 integration tests, and `git diff --check` passed. The
incoming D04 `withDraftCapture` fix resolves the earlier build/capture blocker.
Before that pull, the full suite passed 498 backend tests (including all 86 Git
checks) and 8 frontend tests, with 17 failures isolated to that missing method.
The full suite has not been rerun after the pull.

---
## D04 — Live draft to Git capture
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles A, C, and D
**Action required:** A07 can use the checkpoint endpoint; C06/D06 should inject
the runtime's `collaboration.capture`. Read [the D04 capture contract](interfaces/git.md#live-draft-capture-d04),
including the initiating browser's persistence acknowledgement prerequisite and
the draft-only meaning of `contextHash`. No migration or dependency is required.

- Shared live-room coordinator and FIFO task gate; capture takes the existing
  workspace Git lock first. Later updates resume in order without resetting Yjs.
- Complete active-document text export, including disconnected snapshots and
  guarded initialization, into one human-draft Git checkpoint.
- Exact document revisions and deterministic capture digest; checkpoint metadata
  and `draft.checkpointed` event are committed in one database transaction.
- Contributor checkpoint HTTP route, safe failure/retry handling, and shutdown
  draining of capture and queued edits before database cleanup.
- No Start orchestration, worker integration, reviews, Apply, frontend, migrations,
  or broadcast changes.

Verified: `npm run build`, `git diff --check`, and `npm test`: 447 backend
tests (including 25 D04 checks) and 8 frontend tests passed. Focused D01–D03
Git/runtime regressions and the D03/D04 collaboration run also passed.

---

## C04 — Worker tools and checkpoints
**Landed:** 2026-09-12 · `d95a8e8` · Role C
**Affects:** Roles B, C, and D
**Action required:** C05 must persist bases/create mutating worktrees before dispatch; C06 supplies captured context and owns cancellation/finalization. Use the shared `WorkerExecutor` and guarded Git capability. Read [C04 integration notes](../apps/server/src/workers/README.md). No migration or dependency is added.

- Added scoped captured-file/material reads, issued source references, atomic
  Git text batches, task-local question waits, and verified completion artifacts.
- Worker model calls, repairs, provider backoff and human waits use C02's sole
  token ledger and fixed deadline. No count quota or model shell access.
- Added the narrow D02 publication guard so queued candidates recheck execution
  state under the Git lock, immediately before updating the worker ref.
- Checkpoint receipts and completion/failure events retain saved work. C05/C06
  scheduling, integration and HTTP orchestration remain separate tickets.
- Rebased onto D03's collaboration update, preserving both interfaces and exports.
- Validation after integration: build passed; full suite passed with 457 backend
  and eight frontend tests, including all 35 C04 tests.

---
## C03 — Orchestrator plan and graph validation
**Landed:** 2026-09-12 · `16d09d2` · Role C
**Affects:** Roles B, C, and D
**Action required:** C06 must supply captured `PlanningContext` and a planning instance; C05/C06 instantiate workers from the saved validated plan. Read [C03 integration notes](../apps/server/src/orchestration/README.md). No migration or new dependency is required.

- Added strict structured planning, graph and exact-path validation, and repairs
  through the existing token/deadline ledger. Removed fixed assignment and
  dependency parser caps.
- Atomically stores the validated plan and capture identity with planning
  completion. Rejects late, canceled, or snapshot-mismatched results.
- Adds shared `PlanningContext`, `OrchestratorPlanningService`, validation error
  kinds, and `agent.failed`; existing contract fields remain available.
- Worker dispatch and the HTTP orchestration hook remain C05/C06 work.
- Integrated the B07 ledger consolidation and D02 updates from main; compatibility
  tests exercise B07 dependency linking and D02's portable path rules.
- Validation: build passed; 397 backend and eight frontend tests passed,
  including 68 C03 planning/validation checks.

---

Every entry carries **Action required**, so you can skim the entries since your
last pull and know in one line whether any of them need anything from you.

## D03 — Yjs room server
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles A and D
**Action required:** Run `npm install` and rebuild `@app/contracts`. A03 should
read [the shared document connection contract](interfaces/git.md#shared-documents-d03)
before binding the editor, especially acknowledgement tracking and closed epochs.
No migration is required.

- Standard Yjs sync/awareness on the runtime's shared HTTP server, scoped by
  workspace, task, document ID, and epoch.
- Shared initialization promises, persisted-state restoration, and one-time
  Git seeding through the B05 guarded initialization surface.
- Immediate live revisions, ordered debounced snapshots, accepted/persisted
  acknowledgements, transient save retries, and safe idle-room eviction.
- Closed-epoch rejection, malformed-frame isolation, awareness cleanup, and
  shutdown flushing before database cleanup.
- No capture/checkpoint, review, Apply, agent, or frontend feature changes.

Verified: `npm run build`, `git diff --check`, and `npm test`: 422 backend
tests (including 25 new D03 tests) and 8 frontend tests passed. The focused
collaboration/runtime run also passed before the additional failure cases.

---

## B06 — Task events and realtime refresh
**Landed:** 2026-09-12 · Role B
**Affects:** Role A primarily; everyone indirectly
**Action required:** Role A — build the **polling** path first against `GET /tasks/:t/events`; realtime is a latency optimisation on top and is `null` until a Supabase project exists. See [`interfaces/role-a.md`](interfaces/role-a.md#staying-current-events-and-refresh-hints). Role D — the intermittent suite failure is now identified as your `git-files` test timing out at the shared 30s limit, not a logic bug; see [`pitfalls.md`](pitfalls.md#the-intermittent-suite-failure-is-a-git-test-timing-out). No migration.

- Hints are swept out of `task_events` rather than sent at each append site, so
  §11.5's "persist before broadcasting" holds by construction: a rolled-back
  transaction leaves no row and announces nothing. Appending stays a plain
  database operation, so no service needs a transport to record what it did.
- The sweep starts from the newest existing event, not from the beginning —
  replaying history on boot would be a burst of refetches for changes every
  browser already has.
- A hint carries workspace, task, event type, and event id. **Never the
  payload.** §5.1 assumes a link holder can forge channel messages.
- `GET /tasks/:t/events` — cursor-paginated durable progress record.
- `GET /workspaces/:w/realtime` — channel name plus the publishable location, or
  `null` when unconfigured. The service-role key is never on the wire.
- `SupabaseBroadcaster` written but **unverified against a live project**, same
  status as `SupabaseBlobStore` from B04. Both need a smoke test when the
  project exists.

---

## B07 — Review and run metadata operations
**Landed:** 2026-09-12 · Role B
**Affects:** Roles C and D
**Action required:** Everyone — run `npm run db:migrate` (migration `0006` adds a trigger). Role C — **C02 is unblocked**; read [`interfaces/role-c.md`](interfaces/role-c.md). Role D — **D05 and D06 are unblocked**, and `markInterruptedFromPreviousBoots()` fills the placeholder in `recovery/runtime.ts`.

- `PgRunStore`: run capture and settlement, the assignment graph
  (`linkDependencies` with a cycle re-check, `readyInstances` for parallel
  dispatch), and startup reconciliation.
- `PgReviewStore`: review source tuples, staleness invalidation, and the single
  pending apply record with its cross-boot reconciliation.
- Migration `0006` adds a database trigger enforcing §11.2's "a terminal or
  expired instance cannot write". Late *usage* is still recordable; late results
  and outcome changes are not.

**Resolved: `PgAgentLedger` (C02) is the only ledger.** B07's `PgBudgetLedger`
has been deleted, and `PgRunStore` no longer touches agent lifecycle. Role C's
won on three counts: §15.1 assigns `src/agents` to them, their `reserve` derives
the output allowance from the remaining budget as §9.3 step 3 requires rather
than taking a caller-supplied number, and they own the deadline sweep. One
writer to `task_agent_budgets`, one path that creates an instance.

What stayed in `src/runs`: run capture and settlement, the assignment graph
(`linkDependencies`, `readyInstances`), startup reconciliation, reviews, and
apply operations. None of it overlaps the ledger.


---

## C02 — Per-task agent budgets and fixed deadlines
**Landed:** 2026-09-12 · `17aba19` · Role C
**Affects:** Roles B, C, and D
**Action required:** C06 must retain execution scopes, sweep deadlines, and finalize runs. C04/D02 must guard result writes. See [C02 integration notes](../apps/server/src/agents/README.md). No migration or new dependency is required.

- Added atomic reservations and idempotent usage reconciliation against existing
  task-agent budgets, preserving consumed and unknown usage across attempts.
- Added exact-input counting, fixed 600-second execution scopes, abort handling,
  and rejection of late results while retaining late provider usage.
- B07's broader metadata service remains pending; C02 supplies its own focused
  persistence seam. C06 orchestration remains unwired.
- Fixed question-answer lock ordering and expiry rollback, and the Windows Git
  null-config path. Existing Git and runtime tests now pass on this machine.
- Validation: build and all 249 tests passed, including 27 C02 tests.

---

## A01 — Workspace/task UI shell
**Landed:** 2026-09-12 · `f05acce` · Role A
**Affects:** Role A; everyone running the root build/test commands
**Action required:** Run `npm install` at the repository root for the new web workspace. Start the frontend with `npm run dev --workspace @app/web`; the root dev command still starts the server.

- React/TypeScript/Vite shell with workspace navigation, task detail tabs,
  requirements form, and empty/loading/retryable error previews.
- All ten shared task statuses map to the five design section 4.3 board columns.
  Canceled tasks stay in Needs attention for manual retry, never Completed.
- Fixtures validate against shared schemas. Local posting preserves criteria,
  selected materials/files/drafts, and output paths, then opens Discussion with
  no run. Changes reset on reload; API integration remains in later A tickets.
- No account pages, participant directory, model settings, or owner credentials.
  Backend, contracts, and migrations are unchanged.
- Verified after merging C02/B07: six migrations applied; `npm test` passed 289
  backend and eight frontend tests; `npm run build` passed. The A01 workspace
  typecheck also passed. Browser visual
  QA could not run because browser automation was unavailable in this session.

See [`apps/web/README.md`](../apps/web/README.md) for routes and preview controls.

---

## D02 — Draft/worker branches and safe file API
**Implemented:** 2026-09-12 · working tree on main (commit pending) · Role D
**Affects:** Roles C and D
**Action required:** Rebuild `@app/contracts` (`npm run build`) and read
[`interfaces/git.md`](interfaces/git.md) before wiring C04, D03/D04 or D05.
No migration or new dependency is required by D02.

- Persistent human, worker and result branches/worktrees with immutable base
  refs, restart reuse and repair of missing worktrees.
- Additive `createResult`, `readText`, and `applyWorkerChanges` contracts.
  Exact path scopes and Git blob SHA-1 expected hashes guard worker batches.
- Whole-batch validation and one checkpoint commit through a temporary index
  and guarded ref update. Human checkpoints preserve omitted files.
- Portable path, UTF-8, byte-limit and physical filesystem validation. Worker
  content stays inert and separate from human drafts, result branches and main.
- Recovery preserves a committed checkpoint if worktree refresh fails. Unknown
  disk edits are rejected and preserved. C02/C04 still enforce agent lifetime
  and supply authoritative scopes; no new HTTP routes are registered.

Verified: `npm run build`, `git diff --check`, and the complete `npm test` suite:
273 tests passed, including all 67 D01/D02 Git tests. The standalone Git runner
also passed before the final staged-edit regression was added; the final full
suite includes that regression.

---

## C01 — Gemini adapter and backend model routing
**Landed:** 2026-09-12 · `b1be712` · Role C
**Affects:** Role C only, for now
**Action required:** None. Run `npm install` — it added dependencies.

- Google GenAI SDK integration behind a normalised adapter, with a fake adapter
  for tests, per design §9.1.
- Consumes `agentPresetSchema`, `modelUsageSchema`, `AgentPreset` and
  `ModelUsage` from `@app/contracts`.
- Model IDs stay in server configuration; no frontend model controls.

C02 is next for Role C and depends on B07, which has not landed.

---

## B05 — Collaborative snapshot persistence
**Landed:** 2026-09-12 · `673664a`, `6b98ace` · Role B
**Affects:** Role D
**Action required:** Role D — `PgDraftStore` is the persistence layer for D03. Read [`interfaces/role-d.md`](interfaces/role-d.md) before writing the room server.

- Yjs binary state and state vectors persisted per document, with epochs.
- Writes are revision-guarded in the statement: an older snapshot cannot
  overwrite a newer one when an async save lands late. `applied: false` is a
  normal outcome, not an error.
- Seeding is guarded to happen once. Two rooms racing to initialize would merge
  separately initialized copies and duplicate the text.
- `POST /drafts/open` is find-or-create, so concurrent "Edit together" clicks
  converge on one editing session.
- No HTTP route writes a snapshot, deliberately. See
  [`pitfalls.md`](pitfalls.md#a-write-endpoint-is-not-the-only-way-to-expose-a-write).
- `yjs` added as a dependency.

Two defects found and fixed in this ticket's own code — see
[`pitfalls.md`](pitfalls.md).

---

## D01 — Persistent runtime and Git initialization
**Landed:** 2026-09-12 · `237b120` · Role D
**Affects:** everyone
**Action required:** None.

- Process entrypoint, Git data root, one repository per workspace.
- `GitWorkspaceLifecycleHook` implements the contract B02 defined, including the
  fire-and-forget catch and `ensureRepository` for the self-healing path.
- `recovery/runtime.ts` wires Role B's application factory, per design §15.1.

---

## B04 — Workspace and task materials
**Landed:** 2026-09-12 · `ccfd70a` · Role B
**Affects:** Roles A and C
**Action required:** Role C — the context manifest must union two sources, or every attachment is silently dropped from every run. See [`interfaces/role-c.md`](interfaces/role-c.md#the-context-manifest).

- One upload implementation behind all three entry points.
- Storage behind a `BlobStore` interface; local disk now, Supabase later. The
  Supabase implementation is written but **unverified against a live project**.
- Materials are UTF-8 text only. No PDFs, images, or archives.
- Deduplicated by content hash per workspace: identical bytes reuse the existing
  material and answer `200` rather than `201`.
- Reads always serve `text/plain` with an attachment disposition, whatever the
  file is.

---

## B03 — Posted tasks, discussion, and the Start transaction
**Landed:** 2026-09-12 · `767e7b8` · Role B
**Affects:** Roles A and C
**Action required:** Everyone — run `npm run db:migrate` (migration `0005`).

- Post, revise, read, start, cancel, retry, task-local discussion, agent
  question records.
- Posting is inert: no run, no agent instance, no orchestration call.
- Start creates exactly one attempt under both replay and true concurrency, and
  hands the run to `OrchestrationHook.onRunCreated` after commit.
- The discussion cutoff is fixed at run creation and is absolute.
- `needs_input` is derived from open questions, never set directly.

---

## B02 — Anonymous workspace creation
**Landed:** 2026-09-12 · `6ac6b58` · Role B
**Affects:** Roles A and D
**Action required:** Role D — own `apps/server/src/index.ts` and wire it around `buildApp()` from `apps/server/src/http`. Role A — the owner key travels in the `x-owner-key` header.

- Application factory, configuration, boot ID.
- Owner key: 32 random bytes, SHA-256, constant-time comparison. Returned once,
  never readable again, redacted from logs.
- `guidance_version` increments only when the guidance text actually changes.
- `WorkspaceLifecycleHook` defined for Role D to implement.

---

## B01 — Shared schema and contracts
**Landed:** 2026-09-12 · `9ba5d4e` · Role B
**Affects:** everyone
**Action required:** Everyone — import from `@app/contracts` rather than redeclaring types. Additive-only until integration.

- 17 tables, 12 enums, every design §11.2 constraint enforced by the database.
- `packages/contracts`: schemas, status vocabularies, error codes, the §12.3
  interfaces, service interfaces.
- Migration runner with advisory lock and per-file checksums.
- Monorepo scaffold, local Postgres, test harness.

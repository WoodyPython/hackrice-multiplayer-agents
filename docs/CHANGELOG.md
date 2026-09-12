# Changelog

Newest first. One entry per landed ticket.

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
- Verified: the full backend/frontend suite (including 23 frontend tests),
  production build, typecheck, and a local API smoke
  check through Vite covering creation, direct links, contributor rejection, and
  owner updates. Browser visual QA was unavailable in this session.

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

# Changelog

Newest first. One entry per landed ticket.

Every entry carries **Action required**, so you can skim the entries since your
last pull and know in one line whether any of them need anything from you.

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

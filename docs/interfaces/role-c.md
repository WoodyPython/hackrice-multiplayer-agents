# For Role C — orchestration against the data layer

**Reflects:** B05, D02 · **Owner:** Role B (data), Role D (Git handoff)

D02 adds [Git files and checkpoints](git.md) for C04/C05: exact read/write scopes,
Git blob hashes, one checkpoint per accepted batch, and result worktree creation.
Bind the instance and validate its current execution state before calling it.

---

## The context manifest

**Union two sources, or every attachment is silently dropped from every run.**

Design §3.3 says direct task attachments are selected by default, and "selected
by default" is not a stored row:

```
explicit selected inputs   (GET /tasks/:t  →  inputs[])
  ∪  task-attached materials (GET /tasks/:t/materials)
```

Reading only `task_input_links` misses every material someone attached. Writing
a selection row at attach time is the tempting alternative and is wrong: a later
wholesale replacement of the inputs would drop it just as silently, and nothing
would report either failure.

---

## `OrchestrationHook.onRunCreated` — your entry point

B03 creates the run row inside the Start transaction and calls you **after
commit**. The run arrives with `task_version`, `guidance_version`,
`discussion_cutoff_seq`, and `boot_id` already fixed. You fill
`input_snapshot_sha` and `context_manifest` after capture.

Three obligations:

**Never throw back into the caller.** The HTTP response was already sent. On
failure, end the run in a terminal state with a task event explaining why — a
run stuck in `planning` forever is worse than a failed one, because nothing in
the UI can recover from it.

**Check `boot_id` before any write.** A run from a previous boot is interrupted,
and its late results must be rejected (design §14.4).

**Do not re-trigger on a replay.** B03 already suppresses the hook for an
idempotent replay, so if you see a run, it is genuinely new.

---

## The discussion cutoff is absolute

Entries above `discussion_cutoff_seq` never enter any agent's context for that
run, including assignments that have not started yet. Design §2.3 made this
explicit precisely so no assignment reads a different discussion than the one
its plan was built from.

The one exception: an answer to a question the run itself asked reaches the
waiting agent through its question record, not through discussion context.

---

## Agent questions

First-class records, not formatted comments (design §2.6). `ask()` writes an
`agent_questions` row and renders it as a discussion entry.

- **One open question per agent instance.** Enforced by a partial unique index;
  a second `ask()` raises rather than queueing.
- **A question expires at its agent's existing deadline.** Asking never extends
  it. Waiting for a human consumes that clock (design §9.2).
- **We both resolve expired questions.** Your deadline sweep does, and so does
  the answer path — it treats `expires_at` as authoritative and returns
  `AGENT_TIMED_OUT` rather than recording an answer no agent will ever read.
  Both are idempotent so they cannot corrupt each other, but do not write code
  assuming you are the only writer.
- **`needs_input` is derived, not set.** A task reports it while its active run
  has an open question and leaves when none remain. Do not set task status
  directly for this.

---

## Budgets

`task_agent_budgets` is keyed by `(task_id, agent_key)` and **is never reset** —
not by retry, not by a new attempt, not by a model change. An exhausted budget
stays exhausted (design §14.3). Creating a retry instance reuses the row.

The table deliberately has **no** `consumed + reserved <= budget` check. Design
§9.2 records late usage after a deadline abort, and §9.3 reconciles against
provider-reported totals, either of which can legitimately overshoot a
reservation. Enforcement belongs before the call, not in a constraint that would
make honest reconciliation fail.

Reserve-and-reconcile lands in B07; until then the table and its constraints
exist but the atomic operations do not.

---

## Plan validation

`agentPlanSchema` in `@app/contracts` parses model output. Zod covers shape
only. The remaining design §8.3 checks are graph properties it cannot express
and must run before dispatch:

- dependency IDs exist
- the graph is acyclic
- reviewer and analyst assignments declare no write paths
- assignments with overlapping write scopes have an ordering between them

The `max(64)` on assignments is a parser bound against a runaway generation, not
a product limit — design §9.4 explicitly rejects a fixed step count.

---

## Guarantees you can rely on

Materials reach you **pre-validated**: UTF-8, under 1 MiB, no NUL bytes, a
supported text extension. No defensive decoding needed.

Task IDs, workspace IDs, and document IDs are validated as UUIDs at every route
boundary before anything else runs.

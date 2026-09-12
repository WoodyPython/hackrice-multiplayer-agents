# C07: reviewer, evidence, and review handoff

Design section 10.4. Two pieces, both additive to D06's review surface rather
than owned by it: a fresh reviewer-preset assessment against a review's exact
current candidate, and the evidence composed from that plus everything already
durable about the run that produced it.

```ts
const assessments = new ReviewAssessor({ db, adapter, reviews });   // reviews: Pick<LocalReviewService, 'read'>
const evidence = new ReviewEvidenceComposer({ db });
await registerReviewRoutes(app, reviewService, { evidence, assessments });
```

The runtime already wires both; do not construct a second pair against the
same data root — `ReviewAssessor` coalesces in-process by review ID, and two
instances would not see each other's in-flight requests.

## Why this is not built on `PgAgentLedger`

Every existing execution primitive (`AgentExecution`, `WorkerExecutor`,
`PgAgentLedger.reserve`/`recordUsage`) is gated on the task's **active** run:
`isCurrent()` requires `task.active_run_id === run.id`. That gate is exactly
right for a worker or the orchestrator, and exactly wrong here — a review can
be assessed long after the run that produced its candidate went terminal, and
a manual-edit task never had a run at all. Reusing the ledger would mean
weakening the invariant section 14.4 relies on to reject late results, for a
caller that makes no Git or task write and needs no late-result rejection.

`ReviewAssessor` is a self-contained sibling instead: it reserves and settles
against the **same** `task_agent_budgets` table, under a dedicated agent key
`review:<reviewId>`, but never touches `agent_instances` or `runs`. Design
section 9.3's discipline still holds — count the exact input before reserving,
settle every outcome including a failure, never return budget on a failure
with no usable usage — just without an instance row to hang it on.

## What it reads and records

`assess({ workspaceId, taskId, reviewId })` reads the review's **own current
candidate** through an injected `Pick<LocalReviewService, 'read'>` (D06's
service, not Git directly), sends the task's outcome/criteria/guidance plus
every changed file's diff to one reviewer-preset model call, and records the
structured result as a `review.assessed` event — durable, `run_id: null`,
keyed `review:<reviewId>:assessed:<candidateSha>`.

That key is the whole idempotency story: a repeat request against the exact
same candidate returns the recorded finding without spending budget again: a
pre-check reads the event before touching the model or the budget at all. A
later resolution of the review's conflicts produces a new `candidateSha`, and
therefore a genuinely new key — a stale assessment is never silently reused
for content it never examined.

`ReviewEvidenceComposer.compose(...)` produces `ReviewEvidence` (design
section 10.4) from three durable sources, nothing new is stored for it:

- The review's own `changedFiles`, passed straight through from whatever
  `reviews.read()` returned.
- **In-run summaries.** Every non-orchestrator `agent.completed` event for the
  review's `runId`, labeled with its `examinedSha` — always the run's own
  `result_head_sha` (G), never the review's candidate (M). If the run's own
  captured `approvedCommitSha`/`draftCheckpointSha` differ at all from the
  review's `source.mainSha`/`humanSha`, every one of that run's summaries is
  flagged `staleAgainstCandidate: true` — section 10.4's "label the earlier
  finding accordingly; do not imply the AI reviewed the new content."
- **Fresh assessments.** Every `review.assessed` event this review has ever
  produced, `staleAgainstCandidate` set by comparing its `examinedSha` to the
  review's *current* candidate — so an assessment from before a conflict
  resolution reads as stale once a new candidate exists, without needing to be
  deleted or superseded anywhere.

`validationsPerformed` are checks the server actually ran, not a model's
claim: no unresolved conflicts, the stored candidate still matches its
recorded source tuple (re-verified by the caller's own read before evidence
composition ever starts), every required assignment reached `completed`.
`generatedCodeWasNotExecuted` is always `true`.

## What already existed and needed nothing new

Two of design section 16.3's four C07 bullets were already delivered
elsewhere, and building them again here would just be a second, competing
implementation:

- **Ready/incomplete results.** `StartOrchestrator.finish()` (C06) already
  derives the task's terminal status — `ready_for_review`, `conflict`, or
  `incomplete` — from real assignment outcomes once a run settles. See
  [C06's notes](START.md).
- **Request-revision handoff.** Design section 2.4 already allows the
  `planning` transition directly from `ready_for_review` and `conflict`, and
  `PgTaskService.start`/`retry` (B03) already accept it — `assertTransition`
  checks only the current status, not that the task started from `posted`. A
  contributor can already post what needs to change as an ordinary discussion
  entry and start a fresh attempt: C06's capture reads discussion up to the
  new run's cutoff, so that comment reaches the next attempt's orchestrator
  with no new mechanism. Nothing under `apps/server/src/{tasks,discussion}`
  belongs to Role C, so this is intentionally left as B03's existing surface
  rather than a new C-owned route.

## Verification

`npm run test:review --workspace @app/server` uses real PostgreSQL. It covers
budget reservation/settlement (including an exhausted budget and a retried
provider error charging both attempts), idempotency and in-process
coalescing per exact candidate, a blocked/unusable response settling budget
without recording a finding, in-run summary staleness in both directions,
folding a fresh assessment into evidence and re-flagging it stale after a
later resolution, never mixing one review's assessed events into another's,
and the two new HTTP routes end to end. Run `npm run build` and `npm test`
for repository-wide checks. No migration or new dependency is required.

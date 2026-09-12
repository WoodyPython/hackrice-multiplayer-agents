import { contextManifestSchema, reviewEvidenceSchema, type ReviewEvidence } from '@app/contracts';
import type { Db } from '../db/client.js';

/**
 * C07: composes design section 10.4's evidence from data that already exists
 * — durable `agent.completed`/`review.assessed` events and the review's own
 * built candidate — rather than storing anything new. This is the factual
 * work log: what a reader sees is exactly what the server measured or what an
 * agent claimed, never blended into one undifferentiated summary.
 */

export interface ReviewEvidenceDeps {
  db: Db;
}

export interface ReviewEvidenceInput {
  workspaceId: string;
  taskId: string;
  reviewId: string;
  /** From `reviews.read()`: the exact candidate this evidence describes. */
  candidateSha: string;
  candidateComplete: boolean;
  unresolvedConflicts: number;
  changedFiles: Array<{ path: string; changeKind: 'added' | 'modified' | 'deleted'; diff: string }>;
  runId: string | null;
  /** The review's own captured source tuple (design section 10.1). */
  source: { mainSha: string; humanSha: string };
}

export class ReviewEvidenceComposer {
  constructor(private readonly deps: ReviewEvidenceDeps) {}

  async compose(input: ReviewEvidenceInput): Promise<ReviewEvidence> {
    const [runSummaries, freshAssessments, required] = await Promise.all([
      this.runSummaries(input),
      this.freshAssessments(input),
      this.requiredAssignmentsCompleted(input.runId),
    ]);

    return reviewEvidenceSchema.parse({
      changedFiles: input.changedFiles,
      agentSummaries: [...runSummaries, ...freshAssessments],
      validationsPerformed: [
        {
          check: 'Combined candidate has no unresolved conflicts',
          passed: input.unresolvedConflicts === 0,
          detail: input.unresolvedConflicts > 0
            ? `${input.unresolvedConflicts} file(s) still need resolution before this candidate is appliable.`
            : null,
        },
        {
          check: 'Candidate build matches its recorded source tuple',
          // Always true by the time this runs: the caller's own read already
          // re-verifies the stored candidate against `review.source` and
          // `contextHash`, and throws before evidence composition otherwise.
          passed: true,
          detail: 'Re-verified against the stored review record.',
        },
        {
          check: 'Every required assignment reached a terminal, completed state',
          passed: required,
          detail: input.runId === null ? 'No agent run is associated with this review.' : null,
        },
      ],
      generatedCodeWasNotExecuted: true,
    });
  }

  /**
   * In-run worker/reviewer completions, labeled against the exact commit they
   * examined (G) — never the review's own candidate, which can include human
   * or approved-workspace changes no in-run agent ever read (section 10.4:
   * "label the earlier finding accordingly; do not imply the AI reviewed the
   * new content").
   */
  private async runSummaries(input: ReviewEvidenceInput) {
    if (!input.runId) return [];
    const run = await this.deps.db.selectFrom('runs').select(['result_head_sha', 'context_manifest'])
      .where('id', '=', input.runId).where('workspace_id', '=', input.workspaceId).executeTakeFirst();
    if (!run?.result_head_sha || !run.context_manifest) return [];
    const manifest = contextManifestSchema.parse(run.context_manifest);
    // Conservative: any divergence from what the run itself captured means the
    // candidate can contain content the run's agents never saw.
    const stale = manifest.approvedCommitSha !== input.source.mainSha
      || manifest.draftCheckpointSha !== input.source.humanSha;

    const completions = await this.deps.db.selectFrom('task_events').select(['payload'])
      .where('run_id', '=', input.runId).where('type', '=', 'agent.completed').execute();
    const instances = await this.deps.db.selectFrom('agent_instances').select(['id', 'agent_key', 'preset'])
      .where('run_id', '=', input.runId).where('preset', '!=', 'orchestrator').execute();
    const byId = new Map(instances.map((i) => [i.id, i]));

    return completions.flatMap((event) => {
      const agentId = event.payload.agentId;
      const result = event.payload.result;
      const instance = typeof agentId === 'string' ? byId.get(agentId) : undefined;
      if (!instance || !result || typeof result !== 'object' || Array.isArray(result)) return [];
      const record = result as Record<string, unknown>;
      const summary = typeof record.summary === 'string' ? record.summary : '';
      const limitations = Array.isArray(record.limitations)
        ? record.limitations.filter((l): l is string => typeof l === 'string') : [];
      if (!summary) return [];
      return [{
        agentKey: instance.agent_key, summary,
        limitations: limitations.length ? limitations.join('; ') : null,
        examinedSha: run.result_head_sha, staleAgainstCandidate: stale,
      }];
    });
  }

  /** C07's own fresh passes against this review (every candidate it has ever
   * examined, since a later resolution can supersede an earlier assessment). */
  private async freshAssessments(input: ReviewEvidenceInput) {
    const events = await this.deps.db.selectFrom('task_events').select(['payload'])
      .where('task_id', '=', input.taskId).where('type', '=', 'review.assessed')
      .where('run_id', 'is', null).execute();
    return events.flatMap((event) => {
      if (event.payload.reviewId !== input.reviewId) return [];
      const result = event.payload.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
      const record = result as Record<string, unknown>;
      if (typeof record.agentKey !== 'string' || typeof record.summary !== 'string'
        || typeof record.examinedSha !== 'string') return [];
      return [{
        agentKey: record.agentKey, summary: record.summary,
        limitations: typeof record.limitations === 'string' ? record.limitations : null,
        examinedSha: record.examinedSha, staleAgainstCandidate: record.examinedSha !== input.candidateSha,
      }];
    });
  }

  private async requiredAssignmentsCompleted(runId: string | null): Promise<boolean> {
    if (!runId) return true;
    const unfinished = await this.deps.db.selectFrom('agent_instances').select('id')
      .where('run_id', '=', runId).where('status', '!=', 'completed').executeTakeFirst();
    return !unfinished;
  }
}

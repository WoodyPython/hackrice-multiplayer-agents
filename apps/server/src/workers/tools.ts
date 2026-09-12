import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, workerToolArguments, type GuardedWorkerGitService, type MaterialService,
  type WorkerFinish, type WorkerReference, type WorkerResult } from '@app/contracts';
import type { ToolCall, ToolDefinition } from '../models/index.js';
import { isPermittedWritePath } from '../orchestration/validate-plan.js';
import { PgWorkerStore, WorkerToolError } from './store.js';

const path = { type: 'string', description: 'Exact canonical file path under documents/ or code/.' };
const strings = { type: 'array', items: { type: 'string' } };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const WORKER_TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a selected captured file or your worker file. Returns text, expected hash and a source reference.',
    parameters: { type: 'object', required: ['path', 'source'], additionalProperties: false, properties: {
      path, source: { type: 'string', enum: ['worker', 'approved', 'draft', 'saved'] },
      savedOutputId: { type: 'string', description: 'Required only for saved: an ID from selectedSources.savedOutputs.' },
    } } },
  { name: 'read_material', description: 'Read a selected immutable material. Returns a source reference.',
    parameters: object({ materialId: { type: 'string' } }) },
  { name: 'propose_changes', description: 'Checkpoint an atomic batch in your exact write scope. Read first; use returned hashes, null for a new file. No code is executed.',
    parameters: object({ changes: { type: 'array', minItems: 1, items: object({ path,
      expectedHash: { type: ['string', 'null'] }, newText: { type: ['string', 'null'] } }) } }) },
  { name: 'ask_question', description: 'Ask a task-local question and wait within your existing deadline.', parameters: object({ body: { type: 'string' } }) },
  { name: 'finish_assignment', description: 'Finish with a summary, issued reference IDs, limitations and all checkpointed output paths. Call alone.',
    parameters: object({ summary: { type: 'string' }, references: strings, limitations: strings, outputPaths: strings }) },
];

type Binding = Awaited<ReturnType<PgWorkerStore['bind']>>;

/** Keep expected timer cancellation in the execution error vocabulary so the
 * accounting scope does not report Node's AbortError as a background failure. */
export async function waitForWorker(ms: number, signal: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }); }
  catch (error) { signal.throwIfAborted(); throw error; }
}

export class WorkerTools {
  private readonly references = new Map<string, WorkerReference>();
  constructor(private readonly deps: { store: PgWorkerStore; git: GuardedWorkerGitService;
    materials: Pick<MaterialService, 'readSelected'>; binding: Binding }) {}

  private reference(value: Omit<WorkerReference, 'id'>) {
    const id = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const reference = { id, ...value }; this.references.set(id, reference); return reference;
  }

  validate(call: ToolCall): void {
    if (!Object.hasOwn(workerToolArguments, call.name) ||
        !workerToolArguments[call.name as keyof typeof workerToolArguments].safeParse(call.arguments).success) {
      throw new WorkerToolError('invalid_tool_arguments');
    }
  }

  async invoke(call: ToolCall, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.validate(call);
    signal.throwIfAborted();
    const { store, git, binding } = this.deps;
    const { agent, manifest } = binding;
    await store.ledger.assertActive(agent.id);
    switch (call.name) {
      case 'read_file': {
        const args = workerToolArguments.read_file.parse(call.arguments);
        if (args.source === 'saved') {
          const selected = manifest.savedOutputs?.find((s) => s.id === args.savedOutputId && s.path === args.path);
          if (!selected) throw new WorkerToolError('scope_violation');
          const file = await git.readText({ workspaceId: agent.workspace_id, target: { kind: 'commit', commitSha: selected.commitSha },
            path: selected.path, allowedPaths: [selected.path] });
          signal.throwIfAborted(); await store.ledger.assertActive(agent.id);
          if (file.hash !== selected.hash) throw new WorkerToolError('source_changed');
          return { ...file, reference: file.hash ? this.reference({ kind: 'saved', path: file.path, hash: file.hash, commitSha: selected.commitSha }) : null };
        }
        const allowedPaths = args.source === 'worker' ? binding.workerReadPaths : args.source === 'approved'
          ? manifest.approvedPaths : Object.keys(manifest.draftFileHashes);
        if (!isPermittedWritePath(args.path) || !allowedPaths.includes(args.path)) throw new WorkerToolError('scope_violation');
        const commitSha = args.source === 'approved' ? manifest.approvedCommitSha : manifest.draftCheckpointSha;
        if (args.source !== 'worker' && !commitSha) throw new WorkerToolError('source_unavailable');
        const file = await git.readText({ workspaceId: agent.workspace_id, path: args.path, allowedPaths,
          target: args.source === 'worker' ? (['analyst', 'reviewer'].includes(agent.preset)
            ? { kind: 'commit', commitSha: agent.base_sha! } : { kind: 'worker', agentInstanceId: agent.id })
            : { kind: 'commit', commitSha: commitSha! } });
        signal.throwIfAborted();
        await store.ledger.assertActive(agent.id);
        const reference = file.hash ? this.reference({ kind: args.source, path: file.path, hash: file.hash,
          ...(args.source === 'worker' ? {} : { commitSha: commitSha! }) }) : null;
        return { ...file, reference };
      }
      case 'read_material': {
        const { materialId } = workerToolArguments.read_material.parse(call.arguments);
        const selected = manifest.materials.find((item) => item.materialId === materialId);
        if (!selected) throw new WorkerToolError('scope_violation');
        const { material, bytes } = await this.deps.materials.readSelected(agent.workspace_id, materialId);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (material.workspaceId !== agent.workspace_id || material.id !== materialId ||
            material.sha256 !== selected.sha256 || hash !== selected.sha256) throw new WorkerToolError('source_changed');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new WorkerToolError('invalid_source_text'); }
        signal.throwIfAborted(); await store.ledger.assertActive(agent.id);
        return { materialId, text, reference: this.reference({ kind: 'material', materialId, hash }) };
      }
      case 'propose_changes': {
        const { changes } = workerToolArguments.propose_changes.parse(call.arguments);
        if (!['writer', 'coder'].includes(agent.preset) || changes.some((change) =>
          !isPermittedWritePath(change.path) || !agent.write_paths.includes(change.path))) throw new WorkerToolError('scope_violation');
        if (new Set(changes.map((change) => change.path)).size !== changes.length) throw new WorkerToolError('duplicate_path');
        const result = await git.applyGuardedWorkerChanges({ workspaceId: agent.workspace_id,
          agentInstanceId: agent.id, allowedWritePaths: agent.write_paths, changes },
        (checkpoint, publish) => store.checkpoint(agent.id, agent.write_paths, checkpoint, publish, signal));
        return result;
      }
      case 'ask_question': {
        const { body } = workerToolArguments.ask_question.parse(call.arguments);
        const questionId = await store.ask(agent.id, body, signal);
        while (true) {
          const answer = await store.answer(agent.id, questionId, signal);
          if (answer !== null) return { questionId, answer, reference: this.reference({ kind: 'answer', questionId,
            hash: createHash('sha256').update(answer).digest('hex') }) };
          await waitForWorker(250, signal);
        }
      }
      default: throw new WorkerToolError('finish_must_be_called_alone');
    }
  }

  async finish(value: WorkerFinish, signal: AbortSignal): Promise<WorkerResult> {
    value = workerToolArguments.finish_assignment.parse(value);
    const { store, binding, git } = this.deps;
    const agent = await store.ledger.assertActive(binding.agent.id);
    if (new Set(value.references).size !== value.references.length || value.references.some((id) => !this.references.has(id))) {
      throw new WorkerToolError('unknown_reference');
    }
    if (new Set(value.outputPaths).size !== value.outputPaths.length ||
        value.outputPaths.some((path) => !agent.write_paths.includes(path) || !isPermittedWritePath(path))) {
      throw new WorkerToolError('invalid_artifacts');
    }
    const resultSha = agent.result_sha ?? agent.base_sha!;
    const artifacts = [];
    for (const path of value.outputPaths) {
      signal.throwIfAborted();
      const file = await git.readText({ workspaceId: agent.workspace_id, target: { kind: 'commit', commitSha: resultSha },
        path, allowedPaths: agent.write_paths });
      artifacts.push({ path, hash: file.hash });
    }
    return store.finish(agent.id, { summary: value.summary, limitations: value.limitations,
      references: value.references.map((id) => this.references.get(id)!), artifacts, resultSha }, signal);
  }
}

/** Only expected validation failures may return to the model; never leak raw
 * database/provider/filesystem exception messages into conversation history. */
export function repairableToolError(error: unknown): Record<string, unknown> | null {
  if (error instanceof WorkerToolError) return { error: { code: error.code } };
  if (error instanceof ApiError && ['FILE_VERSION_CHANGED', 'INVALID_PATH', 'VALIDATION_FAILED', 'MATERIAL_NOT_FOUND'].includes(error.code)) {
    return { error: { code: error.code, ...(error.code === 'FILE_VERSION_CHANGED' ? { instruction: 'Read the file again before proposing changes.' } : {}) } };
  }
  return null;
}

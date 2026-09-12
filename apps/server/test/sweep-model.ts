import type { AgentPlan, PlanningContext } from '@app/contracts';
import type { AgentRequest, AgentResponse, ModelAdapter, ToolCall } from '../src/models/types.js';

/** Deterministic provider only. Every coordinator, tool, SQL and Git operation stays real. */
export class SweepModel implements ModelAdapter {
  readonly contexts: PlanningContext[] = [];
  readonly requests: AgentRequest[] = [];
  getModel() { return { modelId: 'sweep-fixture', minOutputTokens: 1, maxOutputTokens: 65536 }; }
  async countInput() { return 100; }
  async generate(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(structuredClone(request));
    const response = (toolCalls: ToolCall[], text?: string): AgentResponse => ({ toolCalls, ...(text ? { text } : {}),
      usage: { status: 'reported', totalTokens: 150 }, finishReason: 'STOP' });
    const first = request.messages[0];
    if (first?.role !== 'user') throw new Error('Expected captured input');
    const input = JSON.parse(first.text);
    if (request.preset === 'orchestrator') {
      const context = input.capturedContext as PlanningContext;
      this.contexts.push(context);
      const paths = context.task.outputPaths.length ? context.task.outputPaths : ['documents/result.md', 'code/result.ts'];
      const writers: AgentPlan['assignments'] = paths.map((path, index) => ({ id: `write${index}`,
        preset: path.startsWith('code/') ? 'coder' : 'writer', dependsOn: [], writePaths: [path], instruction: `Write ${path}` }));
      const plan: AgentPlan = { summary: 'Two independent outputs, then inspect their integration.', assignments: [
        ...writers, { id: 'inspect', preset: 'reviewer', dependsOn: writers.map((a) => a.id), writePaths: [], instruction: 'Inspect all outputs.' },
      ] };
      return response([], JSON.stringify(plan));
    }
    if (!request.tools) return response([], JSON.stringify({ summary: 'The candidate contains the synthetic outputs.', limitations: ['Generated code was not executed.'] }));
    const toolTurns = request.messages.filter((message) => message.role === 'tool');
    const paths = input.writePaths as string[];
    if (!toolTurns.length) {
      const calls: ToolCall[] = (paths.length ? paths : input.workerReadPaths as string[]).map((path) => ({ name: 'read_file', arguments: { source: 'worker', path } }));
      for (const draft of input.selectedSources.selectedDrafts ?? []) calls.push({ name: 'read_file', arguments: {
        source: 'draft', path: draft.path, draftFileId: draft.draftFileId,
      } });
      for (const material of input.selectedSources.materials) calls.push({ name: 'read_material', arguments: { materialId: material.materialId } });
      if (calls.length) return response(calls);
    }
    if (paths.length && toolTurns.length === 1) {
      const reads = toolTurns[0]!.results;
      if (reads.some((r) => r.result.error)) throw new Error('A scoped source read failed');
      return response([{ name: 'propose_changes', arguments: { changes: paths.map((path) => ({ path,
        expectedHash: reads.find((r) => r.name === 'read_file' && r.result.path === path)?.result.hash ?? null,
        newText: path.startsWith('code/') ? 'export const result = "verified";\n' : '# Verified result\n\nWritten through the complete runtime.\n',
      })) } }]);
    }
    if (toolTurns.some((turn) => turn.results.some((r) => r.result.error))) throw new Error('A real worker tool refused the fixture');
    const references = [...new Set(toolTurns.flatMap((turn) => turn.results.flatMap((r) => {
      const reference = r.result.reference as { id?: string } | null | undefined;
      return reference?.id ? [reference.id] : [];
    })))];
    return response([{ name: 'finish_assignment', arguments: { summary: `Finished ${input.instruction}`,
      references, limitations: [], outputPaths: paths } }]);
  }
}

import { z } from 'zod';
import { repoPathSchema, shaSchema } from './ids.js';

/** Model arguments never contain workspace/run/agent IDs, refs or scopes. */
export const workerToolArguments = {
  read_file: z.object({ path: repoPathSchema, source: z.enum(['worker', 'approved', 'draft', 'saved']),
    draftFileId: z.string().uuid().optional(), savedOutputId: z.string().uuid().optional() }).strict()
    .refine((v) => (v.source === 'saved') === (v.savedOutputId !== undefined) && (!v.draftFileId || v.source === 'draft')),
  read_material: z.object({ materialId: z.string().uuid() }).strict(),
  propose_changes: z.object({ changes: z.array(z.object({
    path: repoPathSchema, expectedHash: shaSchema.nullable(), newText: z.string().nullable(),
  }).strict()).min(1) }).strict(),
  ask_question: z.object({ body: z.string().trim().min(1).max(20000) }).strict(),
  finish_assignment: z.object({
    summary: z.string().trim().min(1).max(20000),
    references: z.array(z.string().min(1)), limitations: z.array(z.string().min(1).max(4000)),
    outputPaths: z.array(repoPathSchema),
  }).strict(),
};
export type WorkerToolName = keyof typeof workerToolArguments;
export type WorkerFinish = z.infer<typeof workerToolArguments.finish_assignment>;

/** Issued by a successful read, not a model-authored citation. */
export interface WorkerReference {
  id: string;
  kind: 'worker' | 'approved' | 'draft' | 'material' | 'answer' | 'saved';
  path?: string;
  materialId?: string;
  draftFileId?: string;
  questionId?: string;
  hash: string;
  commitSha?: string;
}
export interface WorkerResult {
  summary: string;
  references: WorkerReference[];
  limitations: string[];
  artifacts: Array<{ path: string; hash: string | null }>;
  resultSha: string;
}

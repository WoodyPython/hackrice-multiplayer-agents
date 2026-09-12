import { z } from 'zod';
import { clientRequestIdSchema, repoPathSchema, shaSchema, uuidSchema } from './ids.js';

export const savedOutputSelectionSchema = z.object({ agentInstanceId: uuidSchema, path: repoPathSchema }).strict();
export const retryTaskRequestSchema = z.object({
  clientRequestId: clientRequestIdSchema,
  expectedVersion: z.number().int().positive().optional(),
  savedOutputs: z.array(savedOutputSelectionSchema).max(100).default([]),
}).strict();
export type RetryTaskRequest = z.infer<typeof retryTaskRequestSchema>;

/** Resolved by the server under the task lock, never a client-supplied SHA. */
export const savedOutputOptionSchema = savedOutputSelectionSchema.extend({
  runId: uuidSchema, commitSha: shaSchema,
});
export type SavedOutputOption = z.infer<typeof savedOutputOptionSchema>;
export const listSavedOutputsResponseSchema = z.object({ outputs: z.array(savedOutputOptionSchema) });
export const savedOutputSchema = savedOutputOptionSchema.extend({ id: uuidSchema });
export type SavedOutput = z.infer<typeof savedOutputSchema>;
export const capturedSavedOutputSchema = savedOutputSchema.extend({ hash: shaSchema.nullable(), text: z.string().nullable() });

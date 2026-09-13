import { z } from 'zod';
import { taskIdSchema, timestampSchema, uuidSchema } from './ids.js';

export const inboxTypeSchema = z.enum(['question', 'review', 'failed_run', 'blocker']);
export type InboxType = z.infer<typeof inboxTypeSchema>;
export const inboxItemSchema = z.object({
  /** Stable identity of an issue, independent of refreshes and task titles. */
  id: z.string(),
  type: inboxTypeSchema,
  taskId: taskIdSchema,
  taskTitle: z.string(),
  timestamp: timestampSchema,
  summary: z.string(),
  questionId: uuidSchema.nullable(),
  reviewId: uuidSchema.nullable(),
  runId: uuidSchema.nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const listInboxResponseSchema = z.object({ items: z.array(inboxItemSchema) });

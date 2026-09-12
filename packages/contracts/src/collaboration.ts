import { z } from 'zod';
import { uuidSchema } from './ids.js';

export const LIVE_TEXT_NAME = 'content';
export const LIVE_MESSAGE_SYNC = 0;
export const LIVE_MESSAGE_AWARENESS = 1;
export const LIVE_MESSAGE_QUERY_AWARENESS = 3;
/** varUint(type), varUint(subtype), varUint(revision). Server -> client only. */
export const LIVE_MESSAGE_ACK = 4;
export const LIVE_ACK_ACCEPTED = 0;
export const LIVE_ACK_PERSISTED = 1;
export const LIVE_EPOCH_CLOSED_CODE = 4409;

export const liveRoomSchema = z.object({
  workspaceId: uuidSchema.transform((id) => id.toLowerCase()),
  taskId: uuidSchema.transform((id) => id.toLowerCase()),
  draftFileId: uuidSchema.transform((id) => id.toLowerCase()),
  epoch: z.number().int().positive().safe(),
});
export type LiveRoomId = z.infer<typeof liveRoomSchema>;
export type LiveAcknowledgement =
  | { type: 'accepted'; revision: number }
  | { type: 'persisted'; revision: number };

/** HTTP path. For WebsocketProvider roomname use liveRoomPath(input).slice(1). */
export function liveRoomPath(input: LiveRoomId): string {
  const room = liveRoomSchema.parse(input);
  return `/live/${room.workspaceId}/${room.taskId}/${room.draftFileId}/${room.epoch}`;
}

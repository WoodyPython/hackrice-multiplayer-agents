import { z } from 'zod';
import { guestLabelSchema, uuidSchema } from './ids.js';

/**
 * Who currently has this workspace open (design section 1.3, section 5.1).
 *
 * Section 1.3 says presence is "limited to cursors/selections in the currently
 * open document" and that there is "no persistent participant list". This adds
 * neither: nothing is stored, nothing survives a disconnect, and there is no
 * membership record to read back later. It is a live roster of open browsers,
 * discarded the moment they stop saying they are here.
 *
 * Everything in it is self-asserted. The label and colour come from the
 * contributor's own browser, and section 1.3 is explicit that such labels are
 * "unverified display labels" that must "never" enforce ownership or approve
 * changes. Nothing in the system reads this roster for a permission decision;
 * it exists so people can see who they are working alongside.
 *
 * The channel is public and workspace-scoped, per section 5.1, which already
 * assumes "channel messages can be forged by a link holder". A forged presence
 * entry can make a name appear in a list. That is the whole of its power.
 */
export const participantSchema = z.object({
  /** Per-tab, browser-generated. Not the contributor ID, and not durable. */
  presenceId: uuidSchema,
  name: guestLabelSchema,
  /** Hex from the contributor's own palette; validated so it cannot be CSS. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Server clock, so one browser's wrong clock cannot claim to be earliest. */
  since: z.number().int().nonnegative(),
  /** Ephemeral task-local typing state. Omitted when this browser is idle. */
  typingTaskId: uuidSchema.optional(),
  /** Display-only host marker for the currently connected browser. */
  isHost: z.boolean().optional(),
});
export type Participant = z.infer<typeof participantSchema>;

export const presenceRosterSchema = z.object({
  workspaceId: uuidSchema,
  participants: z.array(participantSchema),
});
export type PresenceRoster = z.infer<typeof presenceRosterSchema>;

export const announcePresenceRequestSchema = z
  .object({
    presenceId: uuidSchema,
    name: guestLabelSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    isHost: z.boolean().optional(),
  })
  .strict();
export type AnnouncePresenceRequest = z.infer<typeof announcePresenceRequestSchema>;

/** A browser says it is still here this often. */
export const PRESENCE_HEARTBEAT_MS = 20_000;
/**
 * How long a silent browser stays listed.
 *
 * Two missed heartbeats plus slack. Shorter and an ordinary tab suspension
 * would make people flicker out of the list; much longer and a closed laptop
 * lingers as though someone were still reading.
 */
export const PRESENCE_TTL_MS = 50_000;
/**
 * Per-workspace roster cap.
 *
 * The presence ID is chosen by the browser, so a link holder can mint as many
 * as it likes. The registry is in memory, so it needs a ceiling that is not the
 * attacker's patience. Well past any real session; a room this size has other
 * problems.
 */
export const PRESENCE_MAX_PARTICIPANTS = 50;

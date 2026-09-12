import type { RefreshHint } from '@app/contracts';

/**
 * Refresh-hint transport (design section 5.1).
 *
 * "Use Supabase Realtime for task status, discussion additions, and review
 * invalidation notifications. A realtime event prompts the browser to fetch the
 * authoritative API state."
 *
 * Two properties define this interface and both are load-bearing:
 *
 * A hint carries no authority. Section 5.1: "Assume channel messages can be
 * forged by a link holder; carry only refresh hints, not executable commands or
 * approval decisions." So the payload is a workspace, a task, an event type and
 * an event id — enough to decide what to refetch, and nothing a forged message
 * could act on.
 *
 * Delivery is optional. Section 11.5: "duplicate/missed broadcasts do not
 * change authoritative state." The durable event row is the record; this is a
 * latency optimisation over the polling that section 5 already specifies as the
 * fallback. That is why `hint` never throws — a broadcast failure must not fail
 * the operation that produced the event.
 */
export interface Broadcaster {
  hint(input: RefreshHint): Promise<void>;
}

/**
 * Used when no Supabase project is configured, which is every local run.
 *
 * Not a stub that discards: it records, so tests can assert what would have been
 * sent, and the count of recorded hints is what proves broadcasting happens
 * after commit rather than inside the transaction.
 */
export class RecordingBroadcaster implements Broadcaster {
  readonly sent: RefreshHint[] = [];

  async hint(input: RefreshHint): Promise<void> {
    this.sent.push(input);
  }
}

/**
 * Supabase Realtime Broadcast over its REST endpoint.
 *
 * Plain fetch rather than supabase-js: this is one HTTP call, the service-role
 * key must stay on the server (section 11.4), and the client library's realtime
 * machinery is for subscribers, which is the browser's job rather than ours.
 *
 * UNVERIFIED against a live project. The interface above is covered by tests
 * using RecordingBroadcaster; this implementation needs one smoke test the
 * first time a Supabase project is configured.
 */
export class SupabaseBroadcaster implements Broadcaster {
  constructor(
    private readonly config: { url: string; serviceRoleKey: string },
    private readonly onError?: (error: unknown) => void,
  ) {}

  async hint(input: RefreshHint): Promise<void> {
    const endpoint = `${this.config.url.replace(/\/+$/, '')}/realtime/v1/api/broadcast`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.config.serviceRoleKey,
          authorization: `Bearer ${this.config.serviceRoleKey}`,
        },
        body: JSON.stringify({
          messages: [
            {
              // Workspace-scoped and public: there are no participant
              // identities to scope it any further (section 5.1).
              topic: `workspace:${input.workspaceId}`,
              event: 'refresh',
              payload: input,
            },
          ],
        }),
      });

      if (!response.ok) {
        // Never include the response body: it can echo the request, and the
        // service-role key is in the headers (section 13.3).
        throw new Error(`broadcast failed with ${response.status}`);
      }
    } catch (error) {
      // Swallowed by contract. A hint is a latency optimisation; the event is
      // already durable and a browser that never hears it still refetches on
      // its polling interval.
      this.onError?.(error);
    }
  }
}

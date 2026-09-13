# Realtime latency investigation

The task board and discussion previously polled every five seconds. Active task
status polled every two seconds. None of these views subscribed to the existing
Supabase refresh hints. Ordinary guest discussion posts also appended no task
event, so subscribing alone would not have fixed chat.

Read-only checks of the reported Render task on September 12, 2026 returned HTTP
200: nine warm task/discussion/event reads took 167–406 ms; an initial task read
took 580 ms. These samples separate API latency from the additional 0–5 second
polling wait; they are not a production percentile benchmark. No production
messages were posted. No connected browser was available for UI testing.

## Delivery

`GET /api/workspaces/:workspaceId/realtime/stream` provides same-origin SSE.
The default runtime now delivers hints directly through this stream instead of
round-tripping through the Supabase Broadcast REST endpoint. Supabase Storage
and existing editor WebSockets are unaffected. The old realtime configuration
endpoint remains for compatibility; the new frontend uses the stream directly.

Chat writes append `discussion.posted` in the same transaction as the entry.
Successful HTTP writes wake the durable event pump after the response; its
400 ms sweep still covers background agent activity. Streams contain only IDs
and event types. Browsers refetch authoritative API data, including mutable
questions and run cutoff labels. No schema migration or new dependency is needed.

Each browser tab shares one stream per workspace. Refreshes are serialized and
bursts during an in-flight read produce one trailing read. Reconnect, network
recovery and returning to a visible tab reconcile state. Healthy streams use a
30-second repair poll; disconnected clients retain the existing 2/5-second
fallback. SSE heartbeat comments run every 15 seconds; slow sockets are closed
instead of buffering indefinitely. Shutdown closes streams before draining HTTP.

Immutable build assets already have a one-year cache. Caching mutable chat or
workflow responses with a TTL would introduce stale reads, so this change reduces
redundant polling and shares connections rather than adding a stale response cache.

## Verification and deployment

- Frontend tests cover stream sharing, reconnect reconciliation, malformed and
  cross-workspace hints, task filtering, burst coalescing and cleanup.
- Server stream tests use two real HTTP clients and verify workspace isolation
  and shutdown with open connections.
- Database-backed event tests verify idempotent chat events and the full POST →
  commit → two streams → authoritative discussion read path, with delivery under
  1.5 seconds locally. This is not a measured Render delivery guarantee.
- Run `npm run test --workspace @app/web`, `npm run test:unit`, and
  `npm run test --workspace @app/server -- test/events.test.ts test/tasks.test.ts`.

Deploy both server and frontend, then reload open tabs. In browser Network tools,
the stream should stay pending with `text/event-stream`; inspect its EventStream
frames. A `ready` event should precede `refresh` events. Compare the chat POST
completion, receiving peer's refresh frame, and discussion GET completion.
Disconnect/reconnect a peer and verify missed messages appear without reloading.
The server emits a debug-level `refresh stream connected` log without chat content.

The runtime still uses the existing global event-pump cursor. Events committed
out of global ID order across different tasks can miss a hint; repair polling
remains necessary. A future multi-instance/high-volume deployment should use a
transactional notification/outbox consumer with commit-safe delivery, and measure
database region/pool latency. Background tabs are also subject to browser timer
and connection throttling. The patch has not been deployed to Render by this task.

# Changelog

Newest first. One entry per landed ticket.

## Download a shared draft or an approved file
**Landed:** 2026-09-13 · frontend only
**Affects:** everyone. **Action required:** none.

A Download button on the shared editor's toolbar and on the approved-file
screen, saving the text as a file.

**No endpoint.** Both screens are already looking at the content -- the
approved file was fetched to render it, and the draft is live in the shared
document -- so a download route would fetch it a second time and re-authorize
to do it. This builds a blob and clicks an anchor with `download`, which is the
client-side equivalent of `Content-Disposition`.

The draft saves **what is on screen**, taken from the Yjs text rather than the
persisted snapshot: what somebody means by "download this" includes the words a
collaborator typed a second ago. The filename is the path's last segment, so
`documents/notes.md` saves as `notes.md`.

Verified by hand against a live workspace, both screens: typed into a shared
draft and downloaded it (`notes.md`, `text/plain;charset=utf-8`, exactly the
typed text), and seeded a file on approved main and downloaded that
(`brief.md`, its committed content). No unit tests, deliberately -- this was a
time-boxed addition. `npm run build` and the web suite (176) are green.

## Workspaces you can come back to: home, switching, archive, delete, cleanup
**Landed:** 2026-09-13 · contracts, server, frontend, one migration
**Affects:** everyone. **Action required:** run `npm run db:migrate` (adds
`0014_workspace_lifecycle.sql`). Nothing else; no route or contract was removed.

**Merged with agent histories**, which claimed `0013` first. Per the
convention, this migration renumbered rather than theirs — and that was the
right way round for a concrete reason, not just the rule: theirs was already
applied to the shared database.

Two collisions git could not flag, both resolved here. The migration number,
above. And `schema.test.ts`'s RLS table count: each branch added one table with
row-level security and each raised 24 to 25, so a merge taking either side
compiles, reads correctly, and asserts the wrong number. It is 26.

`errors.ts` merged cleanly and both codes are present; the delete cascade was
re-tested against the new `agent_trace_steps`, which hangs off tasks and agent
instances and goes with them.

Accounts gave a workspace an owner. This gives a person their workspaces back.

**First, the question this started from: were workspaces persistent already?**
Yes, and always have been — a workspace is a Postgres row and has been since
`0002`. What was never persistent was the *way back to one*: before accounts
the only route in was the URL in someone's chat log plus an owner key in one
browser's localStorage, so a cleared browser or a lost link lost the room. What
is added here is the rest of a workspace's life — finding it, putting it away,
and getting rid of it.

**The blocker found on the way in, and fixed first.** `LiveWorkspace` computed
`isOwner` as `workspace.isOwner && !!session.getOwnerKey(id)`. An
account-created workspace has no owner key at all (`0012` made it null on
purpose), so that condition was never true: **the person who created a
workspace could not open its settings, see the member list, or invite anybody.**
Ownership now comes from `workspace.access`, which the server resolves from
membership on the same read. The flag stays advisory — the authorization hook
re-checks every owner route.

**A home page.** `/` is now the account's workspaces rather than a create form:
the ones you belong to (ordered by activity, with role, people and open tasks),
the ones you have only opened by link, and the archived ones, each in their own
section, with "pick up where you left off" from `preferences.lastWorkspace`.
Creating moved to `/new`. Signed out, `/` is still the landing page, and its
right-hand column offers an account instead of a form that could only fail.

**"Workspaces I have the link to" are now recoverable.** `workspace_visits`
records that an account opened a workspace, throttled to one write per five
minutes. **It grants nothing** — authorization still reads `workspace_members`
and only that, a link holder stays a viewer, and the row is private to the
person it belongs to (RLS, per `0004`'s rule that new tables do not inherit it).
It restores the address, never the access.

**Archive and restore**, which is what `workspaces.status` has been waiting for
since `0001` with no route that ever set it. An archived workspace reads
normally and refuses every write, decided in `auth/authorize.ts` alongside
membership so a route added later is covered before anyone remembers — with
three exceptions listed there: restore, delete, and leave. New error code
`WORKSPACE_ARCHIVED` (409, not 403: the request is refused by the state of the
thing, not by who is asking).

**Delete, and leave.** `DELETE /api/workspaces/:w` removes the workspace and
everything cascading from it, plus its repository and its material objects;
`confirmName` must match the workspace's name, checked server-side. `DELETE
/api/workspaces/:w/members/me` lets anyone leave except the last owner. Both
are new; before this nothing could be removed at all.

**`last_activity_at`, and where it is written.** Written with `FOR UPDATE SKIP
LOCKED`, so the sweep steps over a workspace row Apply is holding rather than
queueing behind it — the wait would otherwise happen inside the sweep whose
promise `stop()` awaits, turning a slow transaction elsewhere into a shutdown
that hangs. A skipped row is corrected by the next event in that workspace.
Touched by the event pump,
after the producing transaction commits — **not** in `appendEvent`. That is a
lock-ordering decision: this codebase takes workspace → task → run → budget
(`reviews/service.ts` takes the workspace row first and says so), and
`appendEvent` runs with the task row already locked, so writing the workspace
row from there would invert the order against guidance edits and Apply. Both
paths read correctly alone and deadlock together. Throttled in the WHERE
clause, so a busy workspace does not rewrite the row per event.

**A garbage collector**, `npm run workspace:gc --workspace @app/server`.
Reports database size against the 500 MB free-plan limit and sorts workspaces
into `orphaned` (pre-accounts, unclaimed, memberless), `empty`, and `archived`,
plus repository directories with no workspace row. **It changes nothing without
`--delete`**, because which workspaces are junk is a person's call. A workspace
with members and content is never listed at any age.

**Two bugs fixed in passing, both pre-existing:**
- **`AuthProvider` requested the session in an infinite loop.** `api = new
  AuthApi(supabaseConfig())` as a default parameter constructs a new instance
  per render; `refresh` is a `useCallback` keyed on it, so a new instance meant
  a new `refresh`, which re-ran the effect that called it, which set state.
  Measured at 300+ `GET /api/auth/session` in a few seconds on one page load.
  Invisible in tests (all of them pass a stable `api`) and in the browser
  (every request succeeded). Found independently on the same day by the
  sign-in hardening in `f1aaf81`; that fix is the one kept, since it also
  guards each refresh with a revision so a slow response cannot overwrite a
  newer session.
- **The workspace read was keyed on the browser session's revision**, left over
  from when the request carried an owner key from storage. It carries no
  per-browser secret now, so renaming yourself refetched the whole workspace.

**Presence survives a rename.** `usePresence` keyed its subscription on the
display name, so changing it ran the cleanup — closing the event stream and
sending the "I have left" DELETE — before re-announcing. Adopting the account's
name made that happen on every page load, which is how it was found. The room
subscription is keyed on the room now; a rename is an announcement.

**One display name, not two.** Signing in adopts the account's name for
presence, document cursors, discussion authorship and upload attribution, via
one call on `BrowserSession` rather than eleven call sites learning about
accounts. §1.3 is unchanged: a display name is still never authority — it has
simply stopped contradicting the account the server already verified.

**A thing that was checked and turned out to be a non-issue**, recorded because
the reasoning is not obvious: `agent_questions.answer_entry_id` is ON DELETE
RESTRICT and looked certain to block deleting any workspace with an answered
agent question. It does not — the cascade removes the question before the
RESTRICT check runs, confirmed directly for both `delete from workspaces` and
`delete from tasks`. The constraint is left exactly as `0002` wrote it, and
there is a test so a change to that chain fails a test rather than a deletion.

Verified after both merges: `npm run build`; web **177** across 16 files; server
`unit` (136), then the ten suites either branch touched together (**237**), and
`runtime-flow` + `tasks` (39). Mutation-checked: neutralising the archived
guard, the last-owner copy, `SKIP LOCKED`, or the presence key each fails
exactly the test written for it and nothing else.

Driven end to end in a browser against the live database before the merge: the
home list, the switcher, archive, the archived-write refusal, delete with name
confirmation, and the visited list — then every row it created was removed
again.

**One thing left open, stated rather than buried.** A full sequential server run
showed `apply.test.ts` hanging for 491 seconds against a 30-second timeout. That
file passes in 140 seconds on its own and the hang was never reproduced, so it
is not attributed to this change. What the investigation did find was a real
mechanism, now closed: the pump's activity write could queue behind a workspace
row held by Apply, inside the sweep whose promise `stop()` awaits. `SKIP LOCKED`
removes it. If a full run hangs there again, that is the first place to look,
and it is Role D's collaboration path rather than this one.

## History — agent work: thought process and changes
**Landed:** 2026-09-13 (not yet merged) · contracts, server, frontend, one migration
**Affects:** everyone. **Action required:** run `npm run db:migrate` (adds `0013_agent_trace_steps.sql`).

History now has two tabs: **Applied changes** (unchanged) and **Agent work**,
which lists every agent that is done working (completed, failed, timed out,
out of tokens, canceled or interrupted), newest first. Opening one shows its
result summary and limitations, why it stopped if it did not complete, its
recorded thought process, and the files it changed, using the same `DiffView`
as the Changes tab. Finished agents on the Agents page link straight to their
entry (`/history?view=agents&agent=<id>`).

**What is recorded.** `AgentExecution.generate` appends one `model_turn` row per
successful model call (Gemini's thought summary, visible text, tool calls), and
the worker loop appends one `tool_results` row per batch of tool outcomes. This
covers the orchestrator and workers. Strings are clipped: 20,000 characters for
reasoning and text, 600 for tool arguments and results, so a trace never becomes
a second copy of the files. Rows come from normalized response fields only.
`providerState` and thought signatures never reach a trace. A failed trace write
is reported to the background error log and never fails the agent. Agents that
ran before this change have no recorded steps, and the UI says so.

**Thought summaries are now requested** (`includeThoughts: true`). They arrive as
separate `thought` parts, so they still never mix into `text`, and the replayed
provider state is unchanged. The UI labels reasoning as generated and unchecked.

**The diff is the agent's own work:** `base_sha` against its last accepted
checkpoint (`result_sha`), limited to its write paths, via a new
`ReviewGit.compare` that the review detail now shares. If the commits cannot be
read, the response says `available: false` and the UI says the changes could
not be read. It never shows that as "no changes".

**Endpoints:** `GET /api/workspaces/:w/agent-history` (listing, capped at 200) and
`GET /api/workspaces/:w/agent-history/:agentInstanceId` (detail, reads Git, only
requested when an entry is opened). Both are read-only and scoped to the
workspace, and responses are parsed on the way out, so model IDs and full
instructions stay server-side. A new `AGENT_NOT_FOUND` (404) error code covers
unknown, unfinished, or foreign agents.

## Inbox — actionable items across the workspace
**Landed:** 2026-09-13 (not yet merged) · contracts, server, frontend
**Affects:** everyone. **Action required:** none (no migration).

A new **Inbox** page in the sidebar, with a badge counting what needs someone
now: unanswered agent questions, pending reviews, failed runs, and explicit
blockers. Each item shows its task, type, and time, and links to the right tab
of the task (Discussion to answer, Changes to review or resolve a conflict,
Agents to inspect a run). The list can be filtered by type (`?type=`).

**Derived, not stored.** `GET /api/workspaces/:w/inbox` computes items from task,
run, question, and review rows in one repeatable-read query. There is no
notification table to keep in sync. An item disappears once its source row
changes: a question is answered, expires, or its run ends; a review is applied;
a conflict is resolved; a failure is retried or the task is canceled or
completed. Item IDs are stable (`question:<id>`, `review:<task>`,
`failed_run:<run>`, `blocker:<task>`), and each task counts once per issue. A
run blocked by a failed prerequisite shows as a blocker, not also as a failed
run, and a review being rebuilt stays pending.

**Answers stay separate from comments.** Only the existing `/answer` endpoint
resolves a question. A discussion comment on the task does not.

**Permissions unchanged.** The read has the same link access as the board and is
strictly workspace-scoped. Acting on an item goes through the existing task and
review APIs. Apply stays open to link holders, per the entry below.

**Live updates** reuse `refreshLoop`: the workspace SSE refresh hints, focus and
visibility wakeups, and a 5 s poll. The page and the badge share one snapshot.
If a refresh fails, the page keeps the last list, labels it as stale, and the
badge hides rather than showing an old count.

## Overview — "Catch me up" briefings
**Landed:** 2026-09-13 (not yet merged) · contracts, server, frontend, one migration
**Affects:** everyone. **Action required:** run `npm run db:migrate` (adds `0011_workspace_briefings.sql`).

A new **Overview** page at the top of the sidebar generates a short briefing for
"Since last briefing", "Last hour" or "Last 24 hours": what changed, open agent
questions and reviews waiting on someone, and up to three suggested next steps.
Every point links to the tasks, reviews, approved files or drafts behind it.

**The model never sees an ID and never writes a link.** Records in the window are
given short keys (T1, R1, F1, Q1, A1). Gemini cites keys, and the server maps
them back. A "what changed" point must cite at least one real activity record or
it is dropped, invented keys are discarded, and text with URLs or markup is
refused. Open questions, unresolved reviews and every count come from records,
not from the model. The browser builds routes from typed IDs.

**Read-only.** Generation writes one row to `workspace_briefings` and nothing
else: no task, event, discussion or review changes, and next steps are text.

**Gemini failure is not an error.** A missing key, provider error, timeout
(60 s) or unusable answer returns the factual activity recap instead, labeled
as such. It uses the existing server-side adapter (`analyst` preset), so the
key never reaches the browser.

**History and cutoff** are scoped to the workspace and a per-browser session key
(`x-briefing-session`, stored as a sha256 hash). It is deliberately not the
guest `contributorId`, which editor awareness broadcasts. A row is written only
after a successful Gemini generation. "Since last briefing" always advances the
cutoff. A fixed window advances it only if it reaches back past the previous
one, so nothing in between is skipped. The first briefing covers 24 hours and
the longest window is 14 days. Twenty rows are kept per session.

Generation is rate limited to 12 per minute per client, because it spends model
quota for anyone holding the link. It does not draw on per-task agent budgets:
that table is keyed by task, and a briefing belongs to the workspace.

**Also in this change: fixes after the "fixed up site" and "more general site
fixes" merges.**
- **Review reuse.** `prepare` now reuses a `ready`/`conflict` review only while
  it still matches current inputs, the same run and approved main. Before this,
  it returned the old candidate after a newer run result or a mismatched Git
  head, where it should rebuild or refuse with `INPUT_CONFLICT`. That bypassed
  source validation.
- **Stale tests updated to the intended behavior:**
  - Apply is open to all link holders, so `integration.test.ts` now asserts the
    workspace boundary instead of the owner key.
  - Prepare reuses a freshly resolved review.
  - Uncertain token holds stay reserved but no longer exhaust the budget. The
    per-call allowance has been capped since `60b30df`.
  - The web tests use the new discussion composer, automatic review rebuilds,
    the Workspace settings sidebar link and the file picker.

## UI — review prominence, readable diffs, file explorer, presence
**Landed:** 2026-09-13 · frontend, with two server changes
**Affects:** everyone. **Action required:** read the Apply note below.

Six assigned UI items. Two changed rules rather than pixels.

**Apply is no longer owner-gated.** A deliberate departure from §10.3. Owner-only
apply blocked the collaboration the product is for, and there is no identity to
build a narrower rule on: §1.3 forbids treating a guest label as authority, and
"people involved in the task" is a self-typed label anyone with the link can
set. Either the link is enough or the key is; a self-asserted middle ground
would only look like security. **The cost, stated plainly: the workspace URL is
now sufficient to publish to approved main.** Server and client changed
together — §4.6 is right that hiding a button is insufficient, and a visible
button the server refuses is as broken. Settings and guidance stay owner-only.
Four tests across both suites asserted the old policy and now assert the new
one, each saying so at the site: an assertion that encodes a permission rule is
easy to restore by accident.

**A review is announced, still requested.** §4.6 keeps preparation explicit for
two reasons worth keeping — a prepare refuses from about a dozen states and
those refusals only make sense as an answer to something someone asked for, and
it stops two viewers racing a candidate build. So a banner above the tabs says
"The agents have finished their work" in plain language with one button that
prepares and lands the reader on the changes, plus a dot on the Changes tab.
Opening goes through the URL, so a review is linkable.

**Diffs are rendered.** `git diff` stdout was a `<pre>` with `tab-size: 2`. Now
dual line-number gutters, +/- glyphs, word-level highlighting for one-for-one
replacements (skipped where runs differ in length, since no honest line-to-line
correspondence exists), and hunk headers spelled "Lines 1-7" rather than
`@@ -1,6 +1,7 @@`. Colour is never the only signal: every row carries a glyph
and an off-screen label.

**Files is an explorer.** A tree beside a detail pane, replacing four panels
that showed one action and three kinds of file as four equal lists. Categories
stay separate top-level folders: approved files and drafts carry repository
paths and nest; materials have a filename and no path, and splicing them into
`documents/` would imply they can be edited or applied. An empty category still
appears and still reads as empty.

**Presence**, on the existing SSE room rather than a second transport. Nothing
is stored — §1.3 rules out a persistent participant list, and a durable row
would outlive the browser that wrote it and read as "someone is here" when
nobody is. Everything in the roster is self-asserted and the panel says so.

**Favicon.** `index.html` had no `<link rel="icon">` at all. Drawn from
`LogoMark` so it cannot drift, on a navy tile because a tab strip can be light
or dark and the icon cannot ask which.

Two things worth knowing: `npm install` is required — `@tailwindcss/vite` was
missing from `node_modules`, so the web suite and dev server were both dead on
a fresh checkout. And the `.gitignore` rule for Role D's data root was an
unanchored `data/`, which matches at any depth; it is `/data/` now.

Verified: apps/web 102, server unit 113, apply 26, runtime-flow + tasks 38.

---

## UI follow-up — responsive actions and simpler task/file flows
**Landed:** 2026-09-13 · frontend

- Mutation responses now update task and review screens immediately, and reads
  started before an action cannot overwrite the newer state when they finish.
- Approved files open on a dedicated, linkable viewer screen.
- Contributors can add a text file directly to task context.
- Tasks can be hidden and restored per browser without deleting shared work.
- The task form and detail keep one plain-language brief field (Desired
  outcome); acceptance criteria and internal version numbers are no longer
  shown. Version checks remain in API requests to prevent lost updates.

---

## Fix — subagents could not create files: the worker model's free tier is 20 requests **per day**
**Landed:** 2026-09-13 · Role B (in Role C files)
**Affects:** every agent call
**Action required:** Enable billing on the Google Cloud project behind
`GEMINI_API_KEY`. No code change makes 20 requests/day support a demo.

The orchestrator planned correctly and every writer then failed to produce a
file. It was not the tools, not the token budget, and not the context.

The provider says exactly what it is:

```
429 RESOURCE_EXHAUSTED   model: gemini-3.6-flash
quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaValue: 20
```

**Per day, per project, per model.** A healthy run spends 6-8 worker requests
(`write-haiku` 4 + `review-haiku` 2; `create-hello-doc` 5 + `review-hello-doc` 3),
so a free key funds two or three runs a day. The orchestrator survived because
`ORCHESTRATOR_MODEL` is a *different* model with its own 20, and planning costs
one request — which is precisely why the failure looked like "subagents can't
write files" rather than "out of quota".

From the live database, the writer on the `hello_world.md` run:

```
agent                  preset   calls  billed  refused
orchestrator           orch.        1       1        0
create-markdown-file   writer      14       1       13
review-markdown-file   reviewer     0       0        0
```

One call through, then thirteen refusals at 1s, 2s, 4s, 8s, 16s, 30s, 30s… —
the ladder in `workers/executor.ts` — until the server was restarted.

**The tools were never the problem.** Driven against the live API, a writer goes
`read_file` → `propose_changes {expectedHash: null, newText: "hello world
"}`.
Textbook file creation. It just never got a second request.

Three defects made this unreadable, all fixed here:

- **The provider's `retryDelay` was discarded.** `safeError` kept only the HTTP
  status. Google states when a slot frees; the app retried in 1s when it had
  been told 36s. On a per-day quota each of those is a guaranteed refusal that
  still spends the allowance being waited on. `ModelAdapterError` now carries
  `retryDelayMs`, and `providerBackoffMs` takes the larger of it and the local
  ladder — the ladder still governs errors that say nothing.
- **A hopeless wait burned the whole deadline.** When the stated delay cannot
  fit the remaining time, the agent now fails immediately as
  `provider_rate_limited` instead of idling to `timed_out`, which named the
  clock for something the provider caused. This is deadline arithmetic, not the
  retry cap §9.4 forbids: it counts time, never attempts.
- **A throttled *plan* was completely silent.** C04 emitted
  `agent.waiting {reason: 'provider_backoff'}`; the planner emitted nothing, so
  a rate-limited orchestrator was indistinguishable from one that was thinking.
  `PgPlanStore.providerWait` now mirrors C04's receipt. §8.7 asks for visible
  waiting states and this was the one agent without them.

**Still open, deliberately:** the frontend ignores `provider_backoff` entirely —
`RunOutcome.tsx` only handles `phase === 'start'`, and `Assignments.tsx` keeps
rendering "running". The durable events exist; surfacing them crosses into Role
A's `GET /tasks/:t/agents` schema and is not done here.

Also unfixed, worth a look: a writer's first call is a `read_file` on the file
it is about to create, which returns null. A fifth of a writer's request cost
buys nothing. It is a prompt change, and prompt changes could not be A/B tested
while the quota was exhausted.

Verified: `npm run build`, `models` (**43**), `workers` (**37**), `planning`
(**70**), `agents` (**28**), `start` (**9**), `scheduler` (**20**).
Mutation-checked by neutralising both the retry-after and the deadline guard and
watching exactly the four new tests fail.

---

## Fix — the orchestrator reserved the entire token budget on its first call
**Landed:** 2026-09-13 · Role B (in Role C files)
**Affects:** every agent call
**Action required:** None.

"Create a text file saying hello world" reported `token_exhausted` on three
attempts. It was not the context, and not a real limit.

`AgentExecution.generate` takes an optional `maxOutputTokens` and **no caller
passes it**, so `reserve` used the model ceiling (65536) against a 64000 budget
and held `inputTokens + 65536` — the whole budget, on the first call.

Measured live, with accounting logging added for the purpose:

```
preset         input  granted  reserved   billed
orchestrator     521    63479     64000     1311
writer          1030    62970     64000     1313
reviewer        1258    62742     64000     1405
```

~1300 tokens billed against a 64000 reservation. Fine while calls succeed —
settlement releases the hold. Fatal when one does not: attempts 2 and 3 made
**no model call at all**, because nothing was left to reserve.

- An unspecified ceiling now defaults to `DEFAULT_OUTPUT_ALLOWANCE` (8192, about
  3.5x the largest total observed). Callers needing more still pass one.
- **New logging**: per-call `inputTokens / requested / granted / reserved /
  billed`, via `onAccounting` wired to the server log. The three numbers being
  indistinguishable is what made this look like a quota problem.

**Verified live.** After the change, reservations are 8714–9570 instead of
64000, and a writer survived **nine consecutive `rate_limited` refusals** —
each refunded by the previous fix — and then completed. Under the old behaviour
the first refusal would have ended the run. Final budgets: all reservations 0,
consumed 708 and 4592 of 64000.

Recorded in [pitfalls](pitfalls.md): every number involved was plausible, which
is why it read as a limit rather than an unset default.

Verified: `npm run build`, `agents`/`start`/`scheduler` (**57**), `workers`
(**35**).

---

## Fix — one transient provider failure no longer kills a run
**Landed:** 2026-09-13 · Role B (in Role C files; see below)
**Affects:** agent execution and token accounting
**Action required:** None.

A refused model request kept its full token reservation. `reserve` takes the
input count plus the whole remaining allowance, so a single transient 503 —
which these models do return under load — stranded roughly 62000 of a 64000
budget, and the planner's next attempt died as `token_exhausted` several layers
from the cause. That is the fragility flagged when agents started working again.

**Not fixed with SDK retries, deliberately.** `retryOptions: { attempts: 1 }`
is principled: `src/models/README.md` states that one `generate` call makes at
most one generation request and that "scheduling and backoff belong to
application code", which is what keeps §9.3's accounting exact. Turning SDK
retries on would make one reservation cover several billable requests.

The actual defect was that application-level backoff *cannot work* while every
refused attempt permanently burns its share of the budget. So
`WorkerExecutionScope` now settles a refused request at zero: a transport
failure, 408, 429 or 5xx that carries no counters did no work and billed
nothing.

Deliberately narrow, and pinned by tests in both directions:

- A failed response that *carries* reported usage still consumes it.
- A permanent (non-retryable) failure still holds its reservation, because it
  may have generated something we cannot count.
- `sent` still guards the case where nothing left the process.

**This edits Role C files** (`src/agents/execution.ts`, `test/agents.test.ts`).
One existing assertion changed meaning: *recounts repeated context and retains
budget/deadline across provider retries* asserted `reserved_tokens: 120` — the
refused attempt's stranded hold — and now asserts `0`. The deadline assertions,
which are that test's actual subject, are untouched. Flagging it explicitly
because an assertion that encodes a leak is easy to restore by accident.

Verified: `npm run build`, `agents` (**28**), `workers` (**35**), and
`agents`/`start`/`scheduler` together (**57**). Mutation-checked by releasing on
every failure and watching both boundary tests fail.

---

## Fix — agents run again: the configured Gemini models were retired
**Landed:** 2026-09-13 · Role B
**Affects:** everyone. `.env` change required.
**Action required:** Set `ORCHESTRATOR_MODEL=gemini-3.8-flash` and
`WORKER_MODEL=gemini-3.6-flash` in your `.env`. Verify with
`npm run gemini:smoke --workspace @app/server`.

Every Start died in the orchestrator. The probe named the cause:

```
gemini-2.5-pro   404  "no longer available to new users ... use gemini-3.1-pro-preview"
gemini-2.5-flash 404  "no longer available to new users ... use gemini-3.6-flash"
```

Two further things had to be true before agents ran:

- **The orchestrator cannot be a Pro model on a free-tier key.**
  `gemini-3.1-pro-preview` counts tokens but refuses to generate with
  `429 ... limit: 0` — a plan-level quota of zero, not a transient rate limit.
  Both tiers are Flash now, and `.env.example` says why.
- **`MODEL_PROFILES` is an allowlist**, so renaming in `.env` alone trades a 404
  for a `configuration` error. The new models are added with `maxOutput` read
  from `models.list()` rather than assumed. The retired ones are kept so an old
  `.env` fails with a message naming the model.

**Verified end to end** against the live API and a real Git root:
`orchestrator:completed → writer:completed → reviewer:completed`, task
`ready_for_review`, `documents/haiku.md` written, and every token reservation
settled to 0 (orchestrator 1505, writer 10612, reviewer 4796 of 64000).

Two diagnostic blind spots closed on the way, both recorded in
[pitfalls](pitfalls.md):

- The sink added last commit was **dead code** — installed from inside
  `configuredAdapter`, which runs before `app` exists, so `app?.log` was always
  undefined. Now installed after the server is built.
- `safeError` returned an already-classified `ModelAdapterError` untouched, so
  the adapter refusing a response logged nothing. That was the case actually
  occurring. Now reported; `aborted` stays silent.
- An empty response (no text, no tool calls) now logs its `finishReason`, since
  the planner treats it as unusable and retries — by which point the budget
  reservation is spent and the failure surfaces as `token_exhausted`, several
  layers from the cause.

**Known fragility, not fixed:** the SDK is configured with
`retryOptions: { attempts: 1 }`. A single transient 503 — which these models do
return under load — leaves the reservation unsettled, and the planner's repair
then has no budget. One blip kills a run. Worth a look before the demo.

Verified: `npm run build`, `models` (**40**), `runtime`/`start`/`agents` (**48**).

---

## Fix — a Gemini provider failure is now diagnosable
**Landed:** 2026-09-13 · Role B
**Affects:** anyone debugging a Start that fails
**Action required:** Run `npm run gemini:smoke --workspace @app/server` when a
Start reports `provider_error`. It names the cause in one command.

Every Start reached the orchestrator and died ~230ms later reporting
`provider_error` — far too fast to be generation, so the API was rejecting the
request outright. Which rejection was unrecoverable.

`safeError()` in the Gemini adapter mapped everything except 429 to
`provider_error` and discarded the original. `ModelAdapterError` is documented
as safe to report anywhere and deliberately carries no provider text, so nothing
downstream could recover it either. §13.3 forbids provider text reaching the
browser; it does not ask us to destroy it.

- The adapter now reports model, HTTP status and the provider's own message to a
  diagnostic sink, wired in `runtime.ts` to the server log. `ModelAdapterError`
  is unchanged and still carries nothing.
- `redactProviderDetail` strips `key=` values and `AIza…` tokens first, because
  Google echoes the request in some errors and a key in a log file is still a
  key. Mutation-checked.
- **New:** `npm run gemini:smoke --workspace @app/server`, modelled on
  `supabase:smoke`. It probes the configured orchestrator and worker models with
  `countTokens` then `generateContent`, prints the real status and message, and
  names the likely fix. It never prints the key.
- Also fixed: `@fastify/static` was declared in `apps/server/package.json` but
  missing from `node_modules`, so `tsc -b` failed on `http/frontend.ts` once the
  incremental cache was invalidated.

This does not itself fix a failing Start — it makes the next one say what is
wrong. Recorded in [pitfalls](pitfalls.md): a redaction boundary belongs at the
edge that publishes, not the edge that catches.

Verified: `npm run build`, `models` (**39**, up from 36), `runtime` and `start`
(**21**).

---

## A08 — Cross-flow UI integration
**Landed:** 2026-09-12 · Role A
**Affects:** Role A. Frontend only — no route, migration, or dependency.
**Action required:** None.

Integration and hardening, per the ticket's own constraint: no new feature
surfaces. Of A08's five items, one was already done and one turned out to be
already covered — the other three were real gaps.

- **Late-edit handling** (§7.6). The Changes tab never learned a review had gone
  stale; it loaded once and kept offering Apply until a click failed with
  `REVIEW_STALE`. §4.7 asks for the opposite — Apply *disabled* and Refresh
  offered — which means knowing before the click. It now takes the latest
  `review.stale` event from the record the task page already polls, so this
  needed no second polling loop and no new endpoint.
- **Closed-document epochs.** The editor already showed the recovery text A03
  built; what was missing was any way forward from it. Applying a review closes
  the epoch, and the page now says so and offers to open the current draft,
  which is §4.7's "keep local text visible, open the current draft".
- **Multi-file approved results**, and the rendered preview §4.6 asks for. This
  was A06 residue rather than A08 work: `GET /reviews/:id/preview` existed and
  was unused. Markdown files now show how they would read beside the diff —
  which matters most in exactly the multi-file case A08 names, because a diff of
  prose is hard to judge. **Rendered as text, not HTML:** §13.2 keeps generated
  content inert and §13.3 never lets stored content become markup on this
  origin, so headings appear as the source that produced them. Design §4.6 is
  amended to say this.
- **Saved-work retries** were done in the residue pass and are unchanged.
- **Owner-key loss** needed nothing. A02 already states it where the decision
  lives: workspace settings says owner controls are unavailable, participation
  continues, and "if browser storage was cleared, owner access cannot be
  recovered" — exactly §1.2. A second copy of that warning elsewhere would make
  a normal contributor's ordinary state look like a problem. Covered by a test
  now so it cannot quietly disappear.

Verified: `npm run build` and the web suite (**74**, up from 70). Frontend only,
so no backend suite is affected. Mutation-checked by cutting the stale signal
and watching the Apply button stay live.

**A08 was the last Role A ticket, and the last ticket on the board.**

---

## B08 — Data integration and focused checks
**Landed:** 2026-09-12 · Role B
**Affects:** everyone. Three status-code fixes; no migration, no dependency.
**Action required:** `/tasks/:t/drafts`, `/tasks/:t/events` and
`/tasks/:t/materials` now answer **404** for a task in another workspace where
they previously answered 200 with an empty list. If anything treated an empty
list as "no such task", it should now read the status instead.

`test/integration.test.ts` drives all five B08 properties through a workspace
that has actually been used — task posted, material attached and reused, draft
edited and checkpointed, review prepared and applied — rather than against an
empty database. Driven through `startRuntime` and HTTP, because scoping and the
owner key are enforced at the route and `buildTestApp` does not even register
the review routes. The flow is a **manual-edit** task, so §2.5's "does not need
agent execution" means the whole sequence runs with no model provider.

**It found a real defect, in three places.** Asking for another workspace's task
returned 200 and an empty list on `/tasks/:t/drafts`, `/tasks/:t/events` and
`/tasks/:t/materials`. Nothing leaked — all three queries were already scoped to
workspace *and* task — but an empty 200 claims "that task is here and has
nothing", which is false and, to anything polling a mistyped link,
indistinguishable from a quiet task. §11.4 makes the workspace in the path the
access check, so a foreign task is absent. Every sibling route already did this.

**Why nothing caught it:** `events.test.ts` had a test named *scopes events to
their workspace* asserting the list came back empty — true of the right answer
and the wrong one alike, since the filter was never the broken part. It never
asserted a status, so it could not fail in the way that mattered. Drafts and
materials had no cross-workspace test at all. That test is now rewritten to
assert the contract rather than a symptom. Recorded in
[pitfalls](pitfalls.md).

Also covered: owner keys refused across workspaces and never echoed back, an
`isOwner` body flag ignored, identical bytes staying one material across
workspace and task uploads but never shared between workspaces, stale
`expectedVersion` refused on both revise and start with the current version
returned, a replayed Start resolving to its original run while a rival is
refused, and a discussion reading back identically from a cold cursor and a
partial one with its cutoff labelling intact.

Verified: `npm run build`, `integration` (**14**), and the three suites owning
the changed files — `drafts`, `events`, `materials` (**77**). Mutation-checked
by reverting the scoping guard and watching the sweep fail.

**B08 was the last Role B ticket.** Role B is complete.

---

## Residue — History built, retry carries saved work, suite health diagnosed
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Roles C and D: read the suite note in your interface file.

An audit pass before A08/B08 rather than new feature work. Three things closed,
one diagnosed and handed over.

**History is built** (§4.1). `GET /workspaces/:w/history` over a new
`PgReviewStore.listHistoryForWorkspace`. It was blocked on D07 having something
to record; D07 landed, so `apply_operations` has rows and the screen is real.
Built on apply operations rather than reviews because §10.5 writes that row
*before* the ref moves — it is the only record that survives a process dying
mid-apply. **Non-applied outcomes are listed**: a `failed`, `ambiguous` or
still-`pending` operation is part of what happened, and hiding it would make a
stuck apply invisible in the one screen meant to explain the past.

**Retry now carries saved work forward** (§2.4, §4.7, C08). The retry button
ignored C08's `savedOutputs`, so every retry silently redid work a previous
attempt had already finished — which is the thing the `incomplete` state exists
to prevent. The task screen now lists what survived, keeps it all by default
(unchecking should be deliberate; re-checking should not be a chore), and sends
**selection identities, never the resolved commit SHA** — C08 resolves that
under the task lock and must not accept a client's.

**The design document was corrected** where it had drifted: §2.1 claimed nothing
in the system could enumerate approved files, but `ManagedWorktrees.tree(sha)`
does exactly that for review building. The ask to Role D shrank from "add a tree
operation" to "wrap the one you have".

**Suite health, diagnosed and not fixed** — it is not Role A's to fix, and the
diagnosis matters more than the symptom:

- `scheduler.test.ts > integrates real parallel C04 checkpoints through D05…`
  fails in a 23-file run after exhausting its own 120-second budget, and
  **passes 19 of 19 in isolation**. The test is fine; the machine is not, after
  twenty-odd suites of real Git and subprocess work run back to back.
- `git-integration.test.ts` takes **over nine minutes in isolation**, around
  seventeen in a full run, with one cancellation test burning 487 seconds before
  failing. `vitest.config.ts` still says "The whole run is a few seconds."

The consequence worth acting on: a red full run is no longer evidence of a
regression, and a suite priced at a quarter of an hour is one people stop
running before pushing — the habit that broke `main` once already. Recorded in
[pitfalls](pitfalls.md) and flagged in the Role C and Role D interfaces.

Verified: `npm run build`, the web suite (**62**, up from 56), and `runs` and
`tasks` (**41** and the rest) — the suites these changes can reach. Mutation-
checked: hiding non-applied history rows, and sending a resolved commit SHA with
a retry selection.

## Cross-subsystem reliability and test cost

**Implemented:** 2026-09-12 · working tree

- Protect pending Apply publication from task mutations and reconcile incompatible
  metadata without overwriting newer state. Invalidate reviews atomically on edits.
- Return browser-compatible Retry responses, preserve retry keys after uncertain
  failures, and pin requirements edits to their original version and selections.
- Cancel surviving workers by active attempt, freeze capture metadata consistently,
  serialize durable task events, and recognize scoped request/answer replays.
- Preserve unknown review usage reservations and settle late provider usage without
  publishing expired assessments. Preserve executable Git file modes.
- Cache bounded immutable Git objects per operation and validate previews without
  generating diffs. Consolidate duplicate fixtures and controlled backoff waits.
- Add HTTP/browser Retry and concurrency regressions. Scoped test commands build
  contracts automatically; `npm run test:unit` needs no database. `npm test` remains
  comprehensive with sequential server suites and one database reset.
- No migration or dependency added. C08 assignment identities, budgets, fresh
  instances, and immutable saved-output references remain unchanged.
- Validation: final workspace build and typecheck passed; comprehensive `npm test`
  passed 645 server tests (765.73s) and 53 web tests (12.02s). DB-free unit tests
  passed 85 cases (6.24s).
- Isolated Git timing against `9b99a6b`: the same two-stage merge-resolution case
  passed in 20.83s before and 11.33s after (whole scoped invocation). This is one
  sequential sample per version, not a full-suite speedup estimate. Complete
  worker integration, restart, CAS, cancellation and CRDT checks remain covered.
- Clean C08 suite timing: 7/7 passed on both versions, 40.40s before and 36.20s
  after (10.4% reduction in this sample). Both runs used the same dependencies,
  one fresh test database reset each, and no competing build/test process. The
  reduced concurrency case retains two same-key callers, a distinct later
  attempt, and historical replay; unknown usage and late settlement remain tested.

---

## A07 — Files and manual collaborative drafts (completed)
**Landed:** 2026-09-12 · Role A
**Affects:** Role A. Frontend only — no route, migration, or dependency.
**Action required:** None.

A04 shipped the half of A07 that was unblocked — reference materials, active
shared drafts, Edit together — and said so. This finishes the rest.

- **Checkpoint** (§7.4, D04) from the editor. It captures every active document
  in the task, not the open file, so the control belongs to the page.
- **Request review** from the editor, which is what makes §2.5's "human-only
  edits can be reviewed without starting agents" reachable without going hunting
  for the Changes tab.
- **Both wait for Saved.** Capture takes the text the server has acknowledged,
  so acting on unsent edits would checkpoint a version nobody has seen. §4.4 is
  precise that Saved means persisted, and this is the thing that depends on it.
- **Saved / Checkpointed / approved are three different states** and the copy
  says so. "Checkpointed in Git … Captured, not approved."
- **Link back to the task**, per §4.4 — it previously went to the workspace,
  which is not where this text is discussed or reviewed.
- `?tab=` deep links, so an action that says it will show you the review does.
  An unrecognised tab name falls back to Discussion rather than rendering an
  empty panel.
- `TaskDrafts` now goes through `WorkspaceApi` instead of raw `fetch`, so it
  shares the error mapping and the transport seam the tests inject through.

**Still blocked: the approved-files view.** `GitService` has `readText(path)` and
no listing. The ask to Role D is narrower than it was, though — see
[their interface](interfaces/role-d.md): `ManagedWorktrees.tree(sha)` already
enumerates a commit for review building, so this is a wrapper rather than a new
Git capability. §2.1 in the design document is corrected to say that.

Verified: `npm run build` and the web suite (**56**, up from 51). Frontend only,
so no backend suite is affected. Mutation-checked: allowing Checkpoint and
Request review with unsent edits fails the test that should catch it.

---

## A06 — Review and conflict UI
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Pull and `npm run build` (contracts gained schemas).

- **New route, `GET /tasks/:t/reviews`** (Role B, over the existing
  `PgReviewStore.listForTask`). This was the missing read path: the only other
  way to reach a review ID was `POST /tasks/:t/review`, which builds a Git
  candidate and refuses from a dozen states — a screen cannot call that on load
  to discover what it is showing.
  Metadata only, deliberately: `GET /reviews/:id` reads the candidate out of
  Git, and a `building` review has no SHA to read, so a list of details would
  cost a Git read per row and fail on the newest one.
- **`currentReview()`** added to contracts so "which review does this screen
  show" has one definition instead of a rule each caller re-derives.
- **Changes tab**: diffs per changed file, owner Apply, conflict resolution by
  whole-file choice, and the stale path.

**A design gap this surfaced, now amended in §4.6.** A task reaches
`ready_for_review` when its assignments integrate (`start.ts`), and **no review
row exists at that point** — nothing calls prepare on its behalf. §4.6 described
what a review displays and never said who creates one. The tab now reports that
state as "no review has been requested yet" and offers to prepare one, because
the absence of a review is not the same claim as "there are no changes". Keeping
it explicit also means prepare's refusals are the answer to something a person
asked for, and two people opening the tab do not race into a candidate build.

**Behaviours worth knowing before touching this code:**

- **Apply sends the candidate SHA that was rendered.** A review that moved
  underneath the browser is refused rather than silently applying something
  else. Same for resolve's `expectedCandidateSha`.
- **Resolving builds a new candidate** (§10.2), never editing the approved one,
  so the SHA changes and anything holding the old one is stale by design.
- **Apply is hidden without an owner key, and that is presentation only.** The
  server checks the key on every apply — §4.6: "hiding a button is
  insufficient." There is a test asserting a contributor still sees the changes.
- **Conflict sides are named** — `human_draft`, `agent_result`, `approved_main`,
  `combined_task`. §10.2 forbids labelling any of them "ours".
- Manual text resolution is not built. Whole-file choice covers §4.6's "explicit
  resolution"; a conflict editor is a separate pass.

Verified: `npm run build`, the web suite (**51**, up from 45), and the backend
suites this touches — `runs`, `tasks` (**67**, `runs` up from 33 to 38). The full
backend suite was not run; nothing here reaches the Git or orchestration suites,
and `git-integration.test.ts` alone still costs 17 minutes with a failing test
that needs Role C or D.

Mutation-checked: applying a SHA other than the rendered one, and allowing Apply
while conflicts are unresolved — both fail the tests that should catch them.

## C08 — Manual retries and failure cases
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, B, C, and D
**Action required:** A05 can consume the saved-output list and optional retry selections. Configure `GEMINI_API_KEY` and run `gemini:smoke` for real-call verification. Read [C08 retry notes](../apps/server/src/orchestration/RETRY.md). No migration or dependency added.

- Retry resolves same-task saved checkpoint selections atomically with its new
  run; client-supplied SHAs and duplicate/foreign selections are rejected.
- Current requirements/draft/materials are captured, while the saved validated
  assignment graph keeps logical budget keys stable across fresh instances.
- Saved files are scoped, immutable reference inputs to `read_file`; earlier
  checkpoints, manifests and usage remain intact.
- Added integrated timeout/cancel/unknown-usage/late-billing tests and prevented
  shutdown during capture from dispatching later work.
- Rebased onto D08 (`4fa3e58`), which now owns startup interruption and pending
  apply reconciliation; real provider verification remains blocked by missing
  Gemini configuration.
- Verified: full workspace build (`npm run build`) and `npm run test:retry`
  (7/7) against real PostgreSQL.

---

## D08 — Minimal restart/retry support
**Implemented:** 2026-09-12 · local main worktree · Role D
**Action required:** None. No migration or dependency. C08 continues to own saved-output selection and broader manual retry behavior.

- Startup interrupts previous-boot execution before creating the application, reconciles pending applies before attaching live transport, then opens orchestration and listens.
- An already-published candidate finalizes operation/review/task/epoch/event metadata atomically. An unchanged expected main retains pending owner/freshness checks; an unrelated main records ambiguity and blocks document writes.
- Recovery errors prevent listening and close initialized resources. Snapshot and Git checkpoint restoration remains on demand; no workflow or model call is replayed.
- Run settlement rejects an active run belonging to another boot or superseded task pointer. Completed artifacts, usage, and terminal attempts remain retained.
- Real-Git integration waits were increased after Windows runs exceeded existing limits; behavioral assertions and production deadlines are unchanged.

**Verified:** Workspace build and whitespace checks passed. All 23 backend test files were covered across batches, including 64 focused apply/runtime/run checks and isolated reruns of seven timing-affected cases; all cases passed. All 38 frontend tests passed. Long combined runs were stopped after losing progress, then completed in smaller batches.

## A05 — Execution and agent progress
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Pull and `npm run build` (the contracts package gained
schemas). Role C: one optional request in [your interface](interfaces/role-c.md).

- **New route, `GET /tasks/:t/agents`** (Role B, `src/tasks/routes.ts` over
  `PgRunStore.listAttemptsForTask`). Returns every attempt newest-first with its
  assignments. Every attempt, not just the latest: §4.7 requires an incomplete
  task to show preserved output, so a retry must leave the failed attempt
  inspectable. Task-scoped, not run-scoped, because `activeRunId` is null once a
  run ends.
- **Agents tab** renders assignments in **dependency waves**. §4.5's "parallel
  workers are visibly distinct" is a property of the graph; a flat list shows
  the same data and hides the fact. Assignments sharing a wave genuinely can run
  at once.
- **Run outcomes are explained**, using C06's start-phase reason codes
  (`agent.waiting` with `payload.phase === 'start'`). Each known code maps to a
  sentence this repo owns; an unknown one still renders an explanation, because
  the interface notes say the codes are stable but the set is not closed.
  `payload.omitted[]` is surfaced prominently — it lists selected inputs that
  could not be captured, and without it a contributor believes the agents read a
  document they never saw.
- **Polling adapts**: 2s while an attempt is live, 5s otherwise. §5 makes
  polling authoritative and realtime a latency optimisation, so this is a
  comfort setting. 5s was too coarse for a run — planning → working →
  needs_input can happen inside one tick and the screen looks stuck.
- **Deadline display** is derived from `deadlineAt` for running agents only, and
  past zero says the deadline passed rather than that the agent stopped. Those
  are different, and only `status` knows the second.

**Deliberately not built:**

- **Token figures are absent, not zero.** The ledger has no read method; a zero
  would read as a measurement rather than a missing one. §4.5 marks the display
  optional and §4.7's exhaustion state comes from agent `status`, so nothing is
  blocked. Requested from Role C.
- The response is **schema-validated outbound**, which makes the schema a
  whitelist: a column added to `agent_instances` later cannot reach the browser
  by accident. Do not replace that parse with a cast.
- `agentProgressSchema` is untouched; `assignmentProgressSchema` is a sibling.
  The contracts package is additive-only, and the token fields on the original
  are required.

Verified: `npm run build`, the full web suite (**45 tests**, up from 38), and the
backend suites this touches — `runs`, `tasks`, `drafts`, `events` (**106**, with
`runs` up from 27 to 33). The full backend suite was **not** run: nothing here
reaches the Git or orchestration suites, and `git-integration.test.ts` alone now
costs 17 minutes (see the previous entry — it also has a failing test that needs
Role C or D).

Four properties were mutation-checked by breaking them until the test failed:
the dependency-wave layout, the omitted-inputs panel, instruction summarisation,
and workspace scoping on the new route.

---

## Docs — A05 re-scoped against C05/C06, and the agents gap narrowed
**Landed:** 2026-09-12 · Role A
**Affects:** whoever starts A05, and whoever adds the agents route
**Action required:** None. Read *Starting A05* in
[the Role A interface](interfaces/role-a.md#starting-a05-what-is-and-is-not-blocked)
before picking up A05.

C05 and C06 landed for real (`98c6f14`, `b88eac7`), so the frontend's picture of
execution changed and the documents said otherwise. Re-checked against `main`:

- **Start is no longer inert.** `recovery/runtime.ts` assembles the real
  `StartOrchestrator`; `buildApp` still defaults to `NullOrchestrationHook`,
  which is why tasks move under `npm run dev` and not under `buildTestApp`.
- **A05 splits in two, and only one half is blocked.** The run-lifecycle half —
  start/stop/retry, answering, §4.7's error states — is buildable today against
  endpoints that exist, using C06's start-phase reason codes (`agent.waiting`
  with `payload.phase === 'start'`). Build that first: it is what a demo shows.
- **§4.5's assignment rows are still blocked on one route**, but a much smaller
  one than before. Everything that section *requires* is on `AgentInstance`, and
  `PgRunStore.listInstances(runId)` already returns it from a Role B file. Only
  token usage needs Role C's ledger, and §4.5 marks that optional. Address the
  route by **task**, not by run: `activeRunId` is null once a run ends, and a
  finished attempt's assignments are what someone inspecting an `incomplete`
  task wants to see.
- Design §4.5 amended to say this rather than the flat "no data source yet" it
  carried while orchestration did not exist.
- `context_captured` carries `payload.omitted[]` — selections that could not be
  captured. Worth surfacing in A05: it is the only signal that a selected input
  silently did not reach the model.

Also corrected: [`handoff-b08.md`](handoff-b08.md) said C05 was a phantom. It
was, for about an hour — `6950fc3` added only an npm script pointing at a
missing vitest config. The real scheduler landed in `98c6f14`. The note is kept,
because the lesson holds: a commit message is not evidence a ticket landed.

**B08 now waits on exactly two tickets, C07 and D07, and they are independent.**
Both are unblocked today, so they can run in parallel.

Verified on merged `main`: `npm run build` passes. The full suite was **not**
re-run to completion for this docs-only change — but a partial run surfaced
something the team should own:

**`git-integration.test.ts` is now pathological, and one test in it fails.**
`D05 worker integration > preserves refs and guard errors when cancellation
rejects prepared fast-forward, merge, or no-op results` ran for **487 seconds**
and failed; the file as a whole took **17 minutes**. That is most of why a full
run now costs a quarter of an hour. It is Role D's test and C05 modified it
(`98c6f14` touched this file), so it needs one of them rather than a guess from
here. Not a new flake class — `pitfalls.md` already records that an intermittent
failure with no assertion message is a timeout until proven otherwise — but the
scale is new and worth treating as a defect rather than a slow test.

---

## C07 — Reviewer, evidence, and review handoff
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, C, and D
**Action required:** `registerReviewRoutes` now takes a required third argument; rebuild and see the interface note below if anything calls it directly. Two additive routes: `GET .../reviews/:reviewId/evidence` and `POST .../reviews/:reviewId/assess`. Read [C07 integration notes](../apps/server/src/orchestration/REVIEW.md). No migration or dependency is added.

- `ReviewAssessor` runs one fresh reviewer-preset pass against a review's own
  current candidate (design section 10.4), deliberately decoupled from
  `PgAgentLedger`/`agent_instances`: those are gated on the task's active run,
  which a review no longer has by the time anyone asks to assess it. It
  reserves and settles against the same `task_agent_budgets` table under a
  dedicated `review:<reviewId>` key, records its result as a durable
  `review.assessed` event, and is idempotent per exact candidate SHA — a
  repeat request against the same candidate is read back, never re-run.
- `ReviewEvidenceComposer` composes `ReviewEvidence` from durable data alone —
  no new table. In-run `agent.completed` summaries are labeled against the run's
  own examined SHA and flagged stale the moment the review's source tuple
  diverges from what that run actually captured; fresh assessments are folded
  in and re-flagged stale once a later resolution produces a new candidate.
  `validationsPerformed` are checks the server actually ran, not a model's claim.
- Two of design section 16.3's four C07 bullets were already delivered by
  earlier tickets and needed no new code: "ready/incomplete results" by C06's
  `StartOrchestrator.finish()`, and the "request-revision handoff" mechanism by
  B03's existing `planning`-from-`ready_for_review`/`conflict` transition plus
  ordinary discussion posting, which C06's capture already reads into the next
  attempt. See the interface note for why no new route was added for either.
- Verified: full build; `npm run test:review` passes all 14 checks against
  real PostgreSQL, including budget exhaustion, a retried provider error
  charging both attempts, in-process coalescing, staleness in both directions,
  and the two new HTTP routes.

## C06 — Explicit Start and captured context
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, B, C, and D
**Action required:** Start now executes. A run reaches a terminal state on every path, so A05 can drive progress from run/task status and the `run:<runId>:start:*` events. C07 picks up `ready_for_review` runs with a recorded `result_head_sha`. The runtime builds the whole Role C stack; do not construct a second scheduler, ledger or executor against one data root. Read [C06 integration notes](../apps/server/src/orchestration/START.md). No migration or dependency is added.

- `StartOrchestrator` implements the B03 `OrchestrationHook`: it captures the
  context manifest, creates the planning instance, runs C03 planning and C05
  dispatch, and terminalizes the run. It never throws into Start, never
  re-triggers on a replay, and leaves a previous boot's run untouched.
- Capture unions explicitly selected inputs with materials attached directly to
  the task (section 3.3), stops discussion at the run's cutoff, and reads
  approved files at the recorded main commit and drafts at the D04 checkpoint.
  Selections that cannot be captured are reported in the capture event rather
  than captured as empty text.
- Additive Git capability `LocalGitService.combineStartSnapshot` implements
  section 8.4's start snapshot. A conflicting combination ends the run before
  any model call, with the task in `conflict` and the affected paths recorded.
  The three-way merge core is now shared with D05's integration path.
- `PgRunStore.settle` takes an optional task status and terminalizes leftover
  assignments, so a run and its task settle in one transaction. Existing callers
  are unaffected. Run/task/agent finalization has one writer.
- Failure reasons are stable codes, never provider or filesystem text.
- The runtime assembles ledger, adapter, planner, scheduler, worker executor and
  orchestrator as per-process singletons, starts the deadline sweep, and stops
  dispatch first on shutdown. Without `GEMINI_API_KEY` the process still serves
  everything else and reports `model_configuration` per Start.
- Verified: full build; `npm run test:start` passes all 8 checks against real
  PostgreSQL and a real repository, including a genuinely diverged main combined
  into one snapshot, and a conflicting one refused before any model call.

## C05 — Parallel assignment scheduler
**Implemented:** 2026-09-12 · working tree · Role C
**Affects:** Roles A, B, C, and D
**Action required:** C06 injects the singleton scheduler/executor and LocalGitService, supplies captured context, and owns durable cancellation/run finalization. D05's real merge is now connected through a guarded capability. Read [C05 integration notes](../apps/server/src/orchestration/SCHEDULER.md). No migration or dependency is added by C05.

- Loads/revalidates the saved plan, creates stable worker instances and complete
  dependency graphs, and dispatches independent workers without a global cap.
- Persists bases and integration receipts, serializes workspace integrations,
  and releases dependents only after successful integration. Conflicts/failures
  retain checkpoints and let independent peers finish.
- Synced upstream through `cb2fe1f` (including D05 `d18cb4d`) and connected D05's
  real merge with exact-source/scope checks and a guard immediately before
  result publication. Isolated callers without D05 keep pending results.
- Adds durable provider backoff/resume events on the existing fixed clock and
  budget. No HTTP Start wiring or frontend progress work is included.
- Focused checks cover concurrency, graph gating, conflicts, failures, stale
  publication, duplicate dispatch, and real parallel C04/D05 merges with
  dependent output reads. Guard checks preserve main/human/worker refs.
- Validation after syncing D05: full build and suite passed with 537 backend
  and 27 frontend tests. The focused scheduler suite also passed all 19 checks.

## Docs — design document amended to match what was built
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. Documentation only; no code.
**Action required:** None. Read the §4.3 note before touching board card copy.

The design document is the specification and wins where anything disagrees with
it, so these are amendments rather than notes filed elsewhere:

- **§4.1 — the editor route.** The table said
  `/w/:w/tasks/:t/edit/:fileId`; A03 shipped `/w/:w/tasks/:t/drafts` with an
  in-page file selector. §4.4 already requires a selector as a control, so a
  per-file route duplicates it and forces a navigation that remounts the Yjs
  binding. The table now matches the implementation.
- **§4.1 — History's data source** is named: `apply_operations` joined to its
  review and task. Empty until D07 writes to it, which makes an empty History a
  correct answer rather than a missing feature.
- **§4.3 — board cards may no longer claim agent activity.** The old wording
  asked for a "current assignment summary" that `TaskSummary` does not carry;
  the first implementation satisfied it with per-status copy, so every working
  task claimed a "Writer" was "preparing a first draft" whether or not such an
  agent existed. That is the fake progress §4.7 forbids.
- **§2.1 — approved files are not selectable** in the input picker, because
  nothing can enumerate them: the Git service has `readText(path)` and no tree
  operation.
- **§4.5 — agent progress has no data source.** `AgentProgress` is fully
  specified in contracts and served by no route; events carry only `{agentId}`.
  Separate from orchestration being absent.
- **§4.6 — review has no read path.** `reviewId` is not on the task detail
  shape and the only way to obtain one is `POST /tasks/:t/review`, a mutation.
  There is no apply route at all.

Also corrected: an earlier note in [the Role A interface](interfaces/role-a.md)
called History possibly unbuildable. That was wrong — `apply_operations` and its
store already exist, and what is missing is a listing method, a route, and a
contract, all in Role B files. It is a small ticket, not a blocked one.

[`handoff-b08.md`](handoff-b08.md)'s status table is updated: **D07 is unblocked
now**, and **C05 is not implemented** despite `6950fc3 "Add C05"` — that commit
adds one npm script pointing at a vitest config that does not exist, with no
scheduler behind it. C06 depends on C05, so anyone planning around it should
confirm first.

---

## A04 — Task posting, discussion, and materials (plus the unblocked half of A07)
**Landed:** 2026-09-12 · Role A
**Affects:** everyone. One additive Role B route; no migration, no dependency.
**Action required:** Pull and `npm run build`. Roles C and D: three endpoints the
frontend needs do not exist — see **Blocked on** below and
[the Role A interface](interfaces/role-a.md#still-missing-and-what-it-blocks).

- **The live workspace was still a placeholder.** A01 built the board, task
  detail, and requirement form against `fixtures.ts` and mounted them only at
  `/demo`; every real route (`/w/:id`, `/files`, `/history`, `/tasks/*`) rendered
  "coming next", and `workspace-api.ts` could only talk about workspaces. All of
  them are now live.
- **Post, revise, discuss, attach, start, stop, retry.** Requirements use §2.1's
  optimistic version check; a 409 keeps what you typed and refetches rather than
  discarding the edit. Every state-changing call carries a `clientRequestId`
  created once per user intent and reused on retry.
- **Agent questions route through `/answer`, not `/discussion`.** §2.6 makes a
  question a record, not a formatted comment. The same words posted as a comment
  would land above the run's discussion cutoff and reach no agent — identical
  text, silently doing nothing. There is a test asserting the endpoint, because
  this is invisible in the rendered output.
- **Entries above the active cutoff are labelled "Added after this run
  started"** (§2.3), and the compose box says plainly that a running attempt
  will not read what you are typing.
- **Files** (§4.1, the A07 half that is not blocked): reference-material upload
  with §3.4's text-only rule stated in the picker, active shared drafts across
  the workspace, and Edit together.
- **Fixed: the board invented agent progress.** `board.ts` hardcoded
  `working → "Writer · preparing a first draft"` and rendered it on every
  working card regardless of what was running, or whether anything was.
  `TaskSummary` carries no assignment summary, so §4.7's "avoid fake progress"
  rules that out. Copy is now state-derived and claims nothing about agents.
- **New:** `GET /api/workspaces/:w/drafts` (Role B, `src/drafts`) lists active
  documents workspace-wide. The Files view cannot use the per-task listing — it
  needs the task ID it is trying to discover.
- `/demo` still works and no longer shares fixture data with live code:
  `RequirementForm` and `TaskDetail` take their options and tab bodies as props
  instead of importing `fixtures.ts`, which is why the live form previously
  offered three material IDs that existed in no real workspace.

**Blocked on, and stated in the UI rather than faked:**

- **Agents tab** — C06 supplies the orchestration hook (`buildApp` still
  defaults to `NullOrchestrationHook`, so Start records an attempt and runs
  nothing), *and* no route serves `AgentProgress`. Both are needed; the schema
  already exists.
- **Changes tab** — C07 and D07. No apply route exists, and nothing exposes a
  task's review ID.
- **Approved files** — nothing in the system can enumerate main; the Git service
  has `readText(path)` and no tree operation. The section says "not available
  yet" rather than showing an empty list, which would claim the workspace has
  approved nothing.
- **History** — §4.1 specifies the screen and no data source exists for it.

**Two divergences from the design document, for the team to rule on:**

1. §4.1 specifies the editor at `/w/:w/tasks/:t/edit/:fileId`. A03 shipped
   `/w/:w/tasks/:t/drafts` with an in-page file selector. The implementation
   looks better — §4.4 requires a file selector as a control, so a per-file
   route duplicates it — but the document still says otherwise, and by our own
   rule the document wins until amended.
2. §4.1's History screen may not be buildable as specified without a new
   endpoint nobody owns.

Verified: `npm run build` and `npm test` — **547 backend + 38 frontend** (544 + 27 before this: three for the new route, eleven for the frontend flows). The three
frontend properties that cannot be seen in rendered output (answer routing,
idempotency-key reuse, no fabricated progress) and the new route's workspace
scoping were each confirmed by mutating the code until the test failed.

---

## Fix — Supabase storage and realtime verified against a live project
**Landed:** 2026-09-12 · Role B
**Affects:** anyone running against Supabase; Role A (realtime is now advertised)
**Action required:** Pull if your `.env` points at a Supabase project. Local-disk
runs are unaffected — the bug was in the Supabase implementation only.

- **Both integrations are verified.** `npm run supabase:smoke --workspace
  @app/server` passes all four checks against a live project. B04 storage and
  B06 realtime are no longer unverified, and the notes saying so are gone from
  `blob-store.ts`.
- **`SupabaseBlobStore` could not recognise a missing object.** Supabase Storage
  answers a GET for an absent object with **HTTP 400**, not 404, and puts the
  status it means inside the body (`"statusCode":"404"`, `"code":"NoSuchKey"`).
  `get` mapped only a real 404 to `null` and threw on everything else, so the
  `null` branch of `BlobStore.get` had never once run against the implementation
  that ships. `delete` had the same hole, which would have turned the upload
  path's lost-dedupe-race rollback into a second error.
  *What it would have cost:* `readSelected` exists to turn a missing object into
  `MATERIAL_NOT_FOUND` rather than feed an empty file to a model. Without this it
  would have been a 500 the first time an object actually went missing.
- Classification is by the body's `code`, never the status: `NoSuchBucket` and
  `AccessDenied` also arrive as 400, so mapping the status class to `null` would
  have converted a mistyped `SUPABASE_STORAGE_BUCKET` into "every material is
  missing" — indistinguishable from an empty store. Six tests cover the recorded
  response shapes; each was checked by mutating the fix until it failed.
- Verified end-to-end against the hosted project, not only by the smoke script:
  workspace creation, `realtime` advertised as an object, upload and
  byte-identical read back through the API, and a row whose object was removed
  from the bucket answering 404 `MATERIAL_NOT_FOUND`. Test rows were removed
  afterwards.
- Docs: a [`pitfalls.md`](pitfalls.md) entry, and the failure table in
  [`supabase-setup.md`](supabase-setup.md) corrected — it promised 404/401/403
  and this project answers 400 for all three.

Verified: `npm run build` and `npm test` — **502 backend + 23 frontend**, all
passing (496 backend before this; the six new tests are the classification
checks). The known `git-files.test.ts` flake did not fire on this run.

---
## D07 - Owner Apply and stale-review handling
**Implemented:** 2026-09-12 - local main worktree (commit pending) - Role D
**Affects:** Roles A, B, C, and D
**Action required:** Apply migration `0007_stale_building_reviews.sql`, rebuild
contracts, and read [the D07 Apply contract](interfaces/git.md#owner-apply-and-stale-reviews-d07).
The migration permits a building review invalidated by typing to remain without
a candidate. Ready/conflict/applied reviews still require a candidate.

- Owner-key-protected exact-candidate Apply, full source/context and live revision
  validation, and guarded atomic main publication.
- Accepted-edit invalidation with durable stale events; queued late updates are
  rejected after successful Apply closes the original document epochs.
- Unique apply receipts, authorized duplicate reconciliation, transactional task,
  review, epoch and event finalization, and closed rooms after post-Git SQL failure.
- Existing A03 closure protocol is reused. A06 UI, C07 AI review and D08 startup
  reconciliation remain separate work. No dependency is added.

Verified: workspace build, `git diff --check`, all 101 Git tests, and all 31
focused D07/D06 tests passed. The full suite passed with 561 backend and 27
frontend tests. D07 adds 23 checks, including real two-client epoch closure,
queued late typing, three duplicate-Apply rounds, and post-publication SQL failure.
Migration 0007 was exercised on the separate test database; apply it to your
development/deployment database before running the updated server.

---


## D06 - Combined review candidates
**Implemented:** 2026-09-12 - local main worktree (commit pending) - Role D
**Affects:** Roles A, C, and D
**Action required:** Rebuild `@app/contracts` and read the
[D06 review contract](interfaces/git.md#combined-review-candidates-d06).
Resolution uses `resolveCandidateRequestSchema` with `expectedCandidateSha`;
second-stage conflicts expose `combined_task` versus `approved_main`.
No migration or new dependency is required.

- Two-stage human/agent/approved combination in temporary review worktrees,
  with private immutable candidates and exact persisted source/context records.
- Contributor prepare/resolve routes and scoped review, diff, and text-preview
  reads; real changed-file data and explicit conflict source labels.
- Whole-file/manual/deletion resolutions, portable namespace conflicts, and
  new commits per resolution round. Old candidates and source branches survive.
- Atomic candidate/status/task/event finalization, existing D04 live capture,
  runtime wiring, and focused Git, database, HTTP, and two-client tests.
- Apply, continuous staleness invalidation, AI assessment/revision dispatch,
  epoch closure, and workflow restart reconciliation remain later tickets.

Verified: workspace build, `git diff --check`, and the full suite passed:
538 backend tests and 27 frontend tests, including 23 D06 Git/API checks.
The new live-capture check uses two real WebSocket clients; no frontend UI was
added or manually exercised by this ticket.

---

## A03 - Simultaneous editor binding
**Landed:** 2026-09-12 - Role A
**Affects:** Role A; A04/A07 can link to shared task drafts
**Action required:** Run `npm install`. Production must proxy `/live` WebSockets to the Node runtime; Vite development and preview already do so. No migration.

- Added `/w/:workspaceId/tasks/:taskId/drafts`, active-document selection,
  Monaco/Yjs binding, shared cursors with live guest renames, and inert Markdown preview.
- Server persistence acknowledgements drive Saved; queued writes and offline
  edits remain unsaved. Reconnect retains the local Yjs document. Closed/rejected
  epochs stop reconnecting and expose recovery text.
- Task posting, file creation, execution, and review flows remain their own tickets.
- Verified: frontend production build/typecheck and 27 frontend tests, including
  two real WebSocket clients against D03 for convergence, awareness, persistence,
  and offline reconnect. No manual two-browser visual check was performed.

---
## Fix — restore `withDraftCapture`, wire Supabase storage, handoff docs
**Landed:** 2026-09-12 · Role B
**Affects:** everyone
**Action required:** Pull. `main` did not build before this.

- **`main` was broken.** Merge `5c483af` resolved a `git/service.ts` conflict
  between C04 and D04 by keeping C04's `applyGuardedWorkerChanges` and dropping
  D04's `withDraftCapture`, leaving its doc comment and every caller in place.
  Restored verbatim from `dde066a`; both methods now exist. Build and the full
  suite are green: **496 backend + 8 frontend**.
  *After any merge where two roles touched one file, build and test before
  pushing — a green branch plus a green branch is not a green merge.*
- **`SupabaseBlobStore` was never selected from configuration.** `buildApp`
  always fell back to local disk, and `config.ts` did not read
  `SUPABASE_STORAGE_BUCKET` despite `.env.example` documenting it. Setting the
  Supabase variables would have enabled broadcasting and silently not storage.
  Both are now chosen from config.
- `npm run supabase:smoke --workspace @app/server` verifies storage and realtime
  against a live project in one command. Both integrations remain **unverified**
  until someone runs it.
- New: [`supabase-setup.md`](supabase-setup.md) and
  [`handoff-b08.md`](handoff-b08.md).

---

## A02 — Guest workspace entry and browser owner controls
**Landed:** 2026-09-12 · `a1b704e` · Role A
**Affects:** Role A; A03/A04 consume the browser session
**Action required:** Run the API and `npm run dev --workspace @app/web` in separate terminals. A03 should bind its open document's awareness through `bindGuestAwareness`; A04 should take new contribution labels from `useGuest()`. See [the browser interface](interfaces/role-a-browser.md). No new dependency or migration.

- Real creation at `/`, direct entry at `/w/:workspaceId`, clean contribution
  links, and owner-only workspace name/purpose/guidance updates through B02.
- Owner keys remain browser-local and workspace-scoped; only metadata reads
  resolving `isOwner` and owner updates carry `x-owner-key`. Sharing reconstructs
  a clean frontend URL with no query, fragment, or secret.
- Editable, validated guest names retain their contributor ID and update the
  document-awareness binding immediately. Saved contribution labels stay intact.
  No accounts or participant directory; live editor/transport remains A03/D03.
- Handles blocked storage, a failed one-time key save, permission loss, missing
  workspaces, clipboard failure, and duplicate creation clicks. Failed settings
  saves preserve entered text. A01's fixtures now live under `/demo/w/*`.
- Verified for A02: 23 frontend tests, frontend production build/typecheck,
  and a local API smoke
  check through Vite covering creation, direct links, contributor rejection, and
  owner updates. Browser visual QA was unavailable in this session.

---

## D05 — Parallel worker-result integration
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles C and D
**Action required:** Rebuild `@app/contracts`. C05 should read
[the D05 integration contract](interfaces/git.md#worker-result-integration-d05),
especially ordered result-head recording, completed-worker authority, and the
requirement that prerequisites integrate before dependents start. No migration
or dependency is added.

- Serialized three-way integration into the existing result branch, with
  fast-forward and two-parent merge commits and guarded ref publication.
- Complete conflict paths from unresolved Git stages and portable namespace
  collisions; conflicts preserve the result, workers, human drafts, and main.
- Immutable base validation, whole-tree text checks, idempotent repeated/no-op
  integration, and preserved commits after result projection failures.
- Runtime schemas, focused Git tests, and C05 handoff documentation. Scheduler,
  metadata lifecycle, review, Apply, Yjs, and restart orchestration are unchanged.

Verified after reconciling `origin/main` at `9c14b3a`: `npm run build`, all 44
focused D04 capture/D05 integration tests, and `git diff --check` passed. The
incoming D04 `withDraftCapture` fix resolves the earlier build/capture blocker.
Before that pull, the full suite passed 498 backend tests (including all 86 Git
checks) and 8 frontend tests, with 17 failures isolated to that missing method.
The full suite has not been rerun after the pull.

---
## D04 — Live draft to Git capture
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles A, C, and D
**Action required:** A07 can use the checkpoint endpoint; C06/D06 should inject
the runtime's `collaboration.capture`. Read [the D04 capture contract](interfaces/git.md#live-draft-capture-d04),
including the initiating browser's persistence acknowledgement prerequisite and
the draft-only meaning of `contextHash`. No migration or dependency is required.

- Shared live-room coordinator and FIFO task gate; capture takes the existing
  workspace Git lock first. Later updates resume in order without resetting Yjs.
- Complete active-document text export, including disconnected snapshots and
  guarded initialization, into one human-draft Git checkpoint.
- Exact document revisions and deterministic capture digest; checkpoint metadata
  and `draft.checkpointed` event are committed in one database transaction.
- Contributor checkpoint HTTP route, safe failure/retry handling, and shutdown
  draining of capture and queued edits before database cleanup.
- No Start orchestration, worker integration, reviews, Apply, frontend, migrations,
  or broadcast changes.

Verified: `npm run build`, `git diff --check`, and `npm test`: 447 backend
tests (including 25 D04 checks) and 8 frontend tests passed. Focused D01–D03
Git/runtime regressions and the D03/D04 collaboration run also passed.

---

## C04 — Worker tools and checkpoints
**Landed:** 2026-09-12 · `d95a8e8` · Role C
**Affects:** Roles B, C, and D
**Action required:** C05 must persist bases/create mutating worktrees before dispatch; C06 supplies captured context and owns cancellation/finalization. Use the shared `WorkerExecutor` and guarded Git capability. Read [C04 integration notes](../apps/server/src/workers/README.md). No migration or dependency is added.

- Added scoped captured-file/material reads, issued source references, atomic
  Git text batches, task-local question waits, and verified completion artifacts.
- Worker model calls, repairs, provider backoff and human waits use C02's sole
  token ledger and fixed deadline. No count quota or model shell access.
- Added the narrow D02 publication guard so queued candidates recheck execution
  state under the Git lock, immediately before updating the worker ref.
- Checkpoint receipts and completion/failure events retain saved work. C05/C06
  scheduling, integration and HTTP orchestration remain separate tickets.
- Rebased onto D03's collaboration update, preserving both interfaces and exports.
- Validation after integration: build passed; full suite passed with 457 backend
  and eight frontend tests, including all 35 C04 tests.

---
## C03 — Orchestrator plan and graph validation
**Landed:** 2026-09-12 · `16d09d2` · Role C
**Affects:** Roles B, C, and D
**Action required:** C06 must supply captured `PlanningContext` and a planning instance; C05/C06 instantiate workers from the saved validated plan. Read [C03 integration notes](../apps/server/src/orchestration/README.md). No migration or new dependency is required.

- Added strict structured planning, graph and exact-path validation, and repairs
  through the existing token/deadline ledger. Removed fixed assignment and
  dependency parser caps.
- Atomically stores the validated plan and capture identity with planning
  completion. Rejects late, canceled, or snapshot-mismatched results.
- Adds shared `PlanningContext`, `OrchestratorPlanningService`, validation error
  kinds, and `agent.failed`; existing contract fields remain available.
- Worker dispatch and the HTTP orchestration hook remain C05/C06 work.
- Integrated the B07 ledger consolidation and D02 updates from main; compatibility
  tests exercise B07 dependency linking and D02's portable path rules.
- Validation: build passed; 397 backend and eight frontend tests passed,
  including 68 C03 planning/validation checks.

---

Every entry carries **Action required**, so you can skim the entries since your
last pull and know in one line whether any of them need anything from you.

## D03 — Yjs room server
**Implemented:** 2026-09-12 · local main worktree (commit pending) · Role D
**Affects:** Roles A and D
**Action required:** Run `npm install` and rebuild `@app/contracts`. A03 should
read [the shared document connection contract](interfaces/git.md#shared-documents-d03)
before binding the editor, especially acknowledgement tracking and closed epochs.
No migration is required.

- Standard Yjs sync/awareness on the runtime's shared HTTP server, scoped by
  workspace, task, document ID, and epoch.
- Shared initialization promises, persisted-state restoration, and one-time
  Git seeding through the B05 guarded initialization surface.
- Immediate live revisions, ordered debounced snapshots, accepted/persisted
  acknowledgements, transient save retries, and safe idle-room eviction.
- Closed-epoch rejection, malformed-frame isolation, awareness cleanup, and
  shutdown flushing before database cleanup.
- No capture/checkpoint, review, Apply, agent, or frontend feature changes.

Verified: `npm run build`, `git diff --check`, and `npm test`: 422 backend
tests (including 25 new D03 tests) and 8 frontend tests passed. The focused
collaboration/runtime run also passed before the additional failure cases.

---

## B06 — Task events and realtime refresh
**Landed:** 2026-09-12 · Role B
**Affects:** Role A primarily; everyone indirectly
**Action required:** Role A — build the **polling** path first against `GET /tasks/:t/events`; realtime is a latency optimisation on top and is `null` until a Supabase project exists. See [`interfaces/role-a.md`](interfaces/role-a.md#staying-current-events-and-refresh-hints). Role D — the intermittent suite failure is now identified as your `git-files` test timing out at the shared 30s limit, not a logic bug; see [`pitfalls.md`](pitfalls.md#the-intermittent-suite-failure-is-a-git-test-timing-out). No migration.

- Hints are swept out of `task_events` rather than sent at each append site, so
  §11.5's "persist before broadcasting" holds by construction: a rolled-back
  transaction leaves no row and announces nothing. Appending stays a plain
  database operation, so no service needs a transport to record what it did.
- The sweep starts from the newest existing event, not from the beginning —
  replaying history on boot would be a burst of refetches for changes every
  browser already has.
- A hint carries workspace, task, event type, and event id. **Never the
  payload.** §5.1 assumes a link holder can forge channel messages.
- `GET /tasks/:t/events` — cursor-paginated durable progress record.
- `GET /workspaces/:w/realtime` — channel name plus the publishable location, or
  `null` when unconfigured. The service-role key is never on the wire.
- `SupabaseBroadcaster` written but **unverified against a live project**, same
  status as `SupabaseBlobStore` from B04. Both need a smoke test when the
  project exists.

---

## B07 — Review and run metadata operations
**Landed:** 2026-09-12 · Role B
**Affects:** Roles C and D
**Action required:** Everyone — run `npm run db:migrate` (migration `0006` adds a trigger). Role C — **C02 is unblocked**; read [`interfaces/role-c.md`](interfaces/role-c.md). Role D — **D05 and D06 are unblocked**, and `markInterruptedFromPreviousBoots()` fills the placeholder in `recovery/runtime.ts`.

- `PgRunStore`: run capture and settlement, the assignment graph
  (`linkDependencies` with a cycle re-check, `readyInstances` for parallel
  dispatch), and startup reconciliation.
- `PgReviewStore`: review source tuples, staleness invalidation, and the single
  pending apply record with its cross-boot reconciliation.
- Migration `0006` adds a database trigger enforcing §11.2's "a terminal or
  expired instance cannot write". Late *usage* is still recordable; late results
  and outcome changes are not.

**Resolved: `PgAgentLedger` (C02) is the only ledger.** B07's `PgBudgetLedger`
has been deleted, and `PgRunStore` no longer touches agent lifecycle. Role C's
won on three counts: §15.1 assigns `src/agents` to them, their `reserve` derives
the output allowance from the remaining budget as §9.3 step 3 requires rather
than taking a caller-supplied number, and they own the deadline sweep. One
writer to `task_agent_budgets`, one path that creates an instance.

What stayed in `src/runs`: run capture and settlement, the assignment graph
(`linkDependencies`, `readyInstances`), startup reconciliation, reviews, and
apply operations. None of it overlaps the ledger.


---

## C02 — Per-task agent budgets and fixed deadlines
**Landed:** 2026-09-12 · `17aba19` · Role C
**Affects:** Roles B, C, and D
**Action required:** C06 must retain execution scopes, sweep deadlines, and finalize runs. C04/D02 must guard result writes. See [C02 integration notes](../apps/server/src/agents/README.md). No migration or new dependency is required.

- Added atomic reservations and idempotent usage reconciliation against existing
  task-agent budgets, preserving consumed and unknown usage across attempts.
- Added exact-input counting, fixed 600-second execution scopes, abort handling,
  and rejection of late results while retaining late provider usage.
- B07's broader metadata service remains pending; C02 supplies its own focused
  persistence seam. C06 orchestration remains unwired.
- Fixed question-answer lock ordering and expiry rollback, and the Windows Git
  null-config path. Existing Git and runtime tests now pass on this machine.
- Validation: build and all 249 tests passed, including 27 C02 tests.

---

## A01 — Workspace/task UI shell
**Landed:** 2026-09-12 · `f05acce` · Role A
**Affects:** Role A; everyone running the root build/test commands
**Action required:** Run `npm install` at the repository root for the new web workspace. Start the frontend with `npm run dev --workspace @app/web`; the root dev command still starts the server.

- React/TypeScript/Vite shell with workspace navigation, task detail tabs,
  requirements form, and empty/loading/retryable error previews.
- All ten shared task statuses map to the five design section 4.3 board columns.
  Canceled tasks stay in Needs attention for manual retry, never Completed.
- Fixtures validate against shared schemas. Local posting preserves criteria,
  selected materials/files/drafts, and output paths, then opens Discussion with
  no run. Changes reset on reload; API integration remains in later A tickets.
- No account pages, participant directory, model settings, or owner credentials.
  Backend, contracts, and migrations are unchanged.
- Verified after merging C02/B07: six migrations applied; `npm test` passed 289
  backend and eight frontend tests; `npm run build` passed. The A01 workspace
  typecheck also passed. Browser visual
  QA could not run because browser automation was unavailable in this session.

See [`apps/web/README.md`](../apps/web/README.md) for routes and preview controls.

---

## D02 — Draft/worker branches and safe file API
**Implemented:** 2026-09-12 · working tree on main (commit pending) · Role D
**Affects:** Roles C and D
**Action required:** Rebuild `@app/contracts` (`npm run build`) and read
[`interfaces/git.md`](interfaces/git.md) before wiring C04, D03/D04 or D05.
No migration or new dependency is required by D02.

- Persistent human, worker and result branches/worktrees with immutable base
  refs, restart reuse and repair of missing worktrees.
- Additive `createResult`, `readText`, and `applyWorkerChanges` contracts.
  Exact path scopes and Git blob SHA-1 expected hashes guard worker batches.
- Whole-batch validation and one checkpoint commit through a temporary index
  and guarded ref update. Human checkpoints preserve omitted files.
- Portable path, UTF-8, byte-limit and physical filesystem validation. Worker
  content stays inert and separate from human drafts, result branches and main.
- Recovery preserves a committed checkpoint if worktree refresh fails. Unknown
  disk edits are rejected and preserved. C02/C04 still enforce agent lifetime
  and supply authoritative scopes; no new HTTP routes are registered.

Verified: `npm run build`, `git diff --check`, and the complete `npm test` suite:
273 tests passed, including all 67 D01/D02 Git tests. The standalone Git runner
also passed before the final staged-edit regression was added; the final full
suite includes that regression.

---

## C01 — Gemini adapter and backend model routing
**Landed:** 2026-09-12 · `b1be712` · Role C
**Affects:** Role C only, for now
**Action required:** None. Run `npm install` — it added dependencies.

- Google GenAI SDK integration behind a normalised adapter, with a fake adapter
  for tests, per design §9.1.
- Consumes `agentPresetSchema`, `modelUsageSchema`, `AgentPreset` and
  `ModelUsage` from `@app/contracts`.
- Model IDs stay in server configuration; no frontend model controls.

C02 is next for Role C and depends on B07, which has not landed.

---

## B05 — Collaborative snapshot persistence
**Landed:** 2026-09-12 · `673664a`, `6b98ace` · Role B
**Affects:** Role D
**Action required:** Role D — `PgDraftStore` is the persistence layer for D03. Read [`interfaces/role-d.md`](interfaces/role-d.md) before writing the room server.

- Yjs binary state and state vectors persisted per document, with epochs.
- Writes are revision-guarded in the statement: an older snapshot cannot
  overwrite a newer one when an async save lands late. `applied: false` is a
  normal outcome, not an error.
- Seeding is guarded to happen once. Two rooms racing to initialize would merge
  separately initialized copies and duplicate the text.
- `POST /drafts/open` is find-or-create, so concurrent "Edit together" clicks
  converge on one editing session.
- No HTTP route writes a snapshot, deliberately. See
  [`pitfalls.md`](pitfalls.md#a-write-endpoint-is-not-the-only-way-to-expose-a-write).
- `yjs` added as a dependency.

Two defects found and fixed in this ticket's own code — see
[`pitfalls.md`](pitfalls.md).

---

## D01 — Persistent runtime and Git initialization
**Landed:** 2026-09-12 · `237b120` · Role D
**Affects:** everyone
**Action required:** None.

- Process entrypoint, Git data root, one repository per workspace.
- `GitWorkspaceLifecycleHook` implements the contract B02 defined, including the
  fire-and-forget catch and `ensureRepository` for the self-healing path.
- `recovery/runtime.ts` wires Role B's application factory, per design §15.1.

---

## B04 — Workspace and task materials
**Landed:** 2026-09-12 · `ccfd70a` · Role B
**Affects:** Roles A and C
**Action required:** Role C — the context manifest must union two sources, or every attachment is silently dropped from every run. See [`interfaces/role-c.md`](interfaces/role-c.md#the-context-manifest).

- One upload implementation behind all three entry points.
- Storage behind a `BlobStore` interface; local disk now, Supabase later. The
  Supabase implementation is written but **unverified against a live project**.
- Materials are UTF-8 text only. No PDFs, images, or archives.
- Deduplicated by content hash per workspace: identical bytes reuse the existing
  material and answer `200` rather than `201`.
- Reads always serve `text/plain` with an attachment disposition, whatever the
  file is.

---

## B03 — Posted tasks, discussion, and the Start transaction
**Landed:** 2026-09-12 · `767e7b8` · Role B
**Affects:** Roles A and C
**Action required:** Everyone — run `npm run db:migrate` (migration `0005`).

- Post, revise, read, start, cancel, retry, task-local discussion, agent
  question records.
- Posting is inert: no run, no agent instance, no orchestration call.
- Start creates exactly one attempt under both replay and true concurrency, and
  hands the run to `OrchestrationHook.onRunCreated` after commit.
- The discussion cutoff is fixed at run creation and is absolute.
- `needs_input` is derived from open questions, never set directly.

---

## B02 — Anonymous workspace creation
**Landed:** 2026-09-12 · `6ac6b58` · Role B
**Affects:** Roles A and D
**Action required:** Role D — own `apps/server/src/index.ts` and wire it around `buildApp()` from `apps/server/src/http`. Role A — the owner key travels in the `x-owner-key` header.

- Application factory, configuration, boot ID.
- Owner key: 32 random bytes, SHA-256, constant-time comparison. Returned once,
  never readable again, redacted from logs.
- `guidance_version` increments only when the guidance text actually changes.
- `WorkspaceLifecycleHook` defined for Role D to implement.

---

## B01 — Shared schema and contracts
**Landed:** 2026-09-12 · `9ba5d4e` · Role B
**Affects:** everyone
**Action required:** Everyone — import from `@app/contracts` rather than redeclaring types. Additive-only until integration.

- 17 tables, 12 enums, every design §11.2 constraint enforced by the database.
- `packages/contracts`: schemas, status vocabularies, error codes, the §12.3
  interfaces, service interfaces.
- Migration runner with advisory lock and per-file checksums.
- Monorepo scaffold, local Postgres, test harness.

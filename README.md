# [Open CoFlow → https://try-coflow.us/](https://try-coflow.us/)

# CoFlow

**A shared workspace for people and AI agents to get work done together.**

CoFlow brings task planning, discussion, collaborative document editing, and AI-generated work into one place. Your team defines the outcome, supplies reference materials, and starts a task when it is ready. Gemini agents divide the work into assignments, produce changes, and ask questions when they need help. People review and apply the result to the workspace's approved files.

Use it to draft documents, turn notes into deliverables, or collaborate on code and text files with an explicit review step.

## What you can do

- **Organize work:** create tasks with outcomes, acceptance criteria, selected inputs, and discussion.
- **Collaborate live:** edit shared drafts with other members, see their cursors, and track who is present.
- **Run a team of agents:** let an orchestrator assign work to analysts, writers, coders, and reviewers, with independent assignments running in parallel.
- **Stay involved:** answer agent questions, stop an attempt, or retry using selected saved outputs.
- **Review changes:** inspect diffs, resolve conflicts, and apply a specific candidate to approved files.
- **Catch up:** use the Inbox for questions and blockers, the Agents page for progress, and Overview for activity briefings.
- **Manage a team:** invite members, switch between workspaces, and archive or restore finished projects.

Posting a task does not start an agent. **Start** is an explicit action. Generated code is saved for review; the application does not execute it.

## Using CoFlow

### 1. Create a workspace and invite your team

Create an account or sign in with your username and password, then create a workspace with a name and purpose. You become its **host**. Add workspace guidance in Settings to give collaborators and agents shared instructions.

Invite people from the workspace's membership controls. An invitation grants membership when accepted; the ordinary workspace link lets someone view the work.

| Role | What they can do |
|---|---|
| Viewer | Read shared tasks, files, and history; appear in presence |
| Member | Create and run tasks, edit documents, answer questions, apply reviews, and mark tasks complete |
| Host | Everything a member can do, plus manage settings, invitations, roles, and workspace lifecycle |

Your home page lists workspaces you belong to and workspaces you have opened by link. Opening a link does not grant editing access.

### 2. Add materials and define a task

Upload reference files and select the materials, approved files, or drafts the task should use. Give the task a concrete outcome and acceptance criteria. Use its discussion to clarify requirements before starting.

For example:

> **Task:** Turn our product notes into an onboarding guide.
>
> **Outcome:** A guide a new teammate can follow without assistance.
>
> **Criteria:** Include setup, the first task, and troubleshooting. Flag missing information.
>
> **Output:** `documents/onboarding.md`

Material uploads can be up to **10 MiB**. Supported UTF-8 text files up to **1 MiB** can become collaborative drafts. Binary files can be stored as references, but there is no general PDF, Office, or image-to-text extraction pipeline for agents.

### 3. Edit drafts together

Open a task's drafts to work in the shared editor. Changes synchronize between connected collaborators, and the editor shows connection and save status. Markdown documents support a preview.

You can also edit files through a manual-edit task and send those changes through review without running agents.

### 4. Start and follow the work

Press **Start** when the requirements and inputs are ready. CoFlow captures the task requirements, guidance, discussion cutoff, and file versions for that attempt.

The orchestrator creates a dependency plan. Workers read their assigned context and produce scoped changes. Use the task details or **Agents** page to follow progress. If an agent needs clarification, answer its question in the task; **Inbox** also surfaces questions that need attention.

Each agent execution has a ten-minute deadline. Each logical task-agent pair has a 256,000-token budget that carries across retries. Human-answer waits and provider backoff count toward the execution deadline.

If an attempt fails or is interrupted, inspect the saved work and retry. A retry can reuse selected checkpoint files. Use a fresh Start when you need a new assignment plan. You can stop a running attempt from its task details.

### 5. Review, apply, and complete

When work is ready, open its review and inspect the changed files. CoFlow combines human edits, agent output, and current approved content. Resolve any conflicts before applying; if the sources change, refresh the stale review.

You can request an AI assessment of the current candidate. Applying the review publishes that exact candidate to the workspace's approved files.

For agent tasks, mark the task complete after checking the applied result. Applying a manual-edit task completes it automatically. Agent tasks can also be started again for further revisions.

### 6. Return to the workspace

- **Overview:** activity and “Catch me up” briefings with links to the underlying work. If AI summarization is unavailable, a factual activity recap is shown.
- **Inbox:** unanswered questions, reviews, conflicts, and unsuccessful attempts requiring attention.
- **Files:** approved content, shared drafts, and uploaded materials.
- **Agents and History:** execution records, saved changes, and previous work.

Hosts can archive a workspace to retain its contents while making it read-only, then restore it later. Members can leave; the last host must retain or transfer administration. Permanent deletion removes the workspace's database content, Git repository, and uploaded objects.

## How it works

| Layer | Technology and responsibility |
|---|---|
| Frontend | TypeScript, React 19, React Router, Vite, Tailwind CSS, Lucide icons |
| Shared editor | Monaco Editor, Yjs, and `y-monaco`; document synchronization over WebSockets |
| API and runtime | Node.js 22, Fastify, Zod validation, and shared TypeScript contracts |
| Application database | PostgreSQL through Kysely and `pg`; stores tasks, accounts, runs, document state, events, and reviews |
| Authentication | Supabase Auth verifies identities; the server issues HttpOnly session cookies and enforces workspace membership |
| Uploaded materials | Private Supabase Storage, with a local-disk fallback |
| AI | Google Gemini through `@google/genai`; custom planning, scheduling, tool validation, accounting, and retry logic |
| Versioned files | Local Git repositories, separate human/worker branches, checkpoints, merges, and guarded publication to approved `main` |
| Live workspace updates | Same-origin Server-Sent Events for refresh hints and presence, backed by polling; a Supabase Realtime adapter also exists but is not wired into the default runtime |
| Hosting | One Render Node service with a persistent disk, backed by Supabase services |

Start captures immutable input versions, so an attempt can be traced to the context it used. Workers can write only their assigned paths. A human applies the reviewed result; agent completion alone does not publish approved files.

### Project layout

```text
apps/web/             React interface and browser tests
apps/server/          API, authentication, agents, collaboration, Git, and recovery
packages/contracts/   Shared schemas, types, statuses, and service interfaces
db/migrations/        Forward-only PostgreSQL migrations
docs/                 Detailed setup, architecture, and operations notes
render.yaml           Render deployment Blueprint
docker-compose.yml    Local PostgreSQL service
```

## Verification

Tests use Vitest, Testing Library, scripted model responses, and real PostgreSQL/Git integration tests. They cover permissions, task execution, collaboration, review, publication, and recovery. Ordinary test runs do not make live Gemini calls.

Migrations are checksum-verified, with new numbered migrations for schema changes. Database types and shared contracts stay in sync.

## Troubleshooting

| Symptom | Check |
|---|---|
| Sign-in or account creation fails | Check Supabase URL/public keys on both server and browser, plus the server secret key for registration; redeploy after browser configuration changes |
| Uploads fail | Confirm that the configured private Storage bucket exists and the server key can access it |
| A task ends with `model_configuration` | Check `GEMINI_API_KEY` and the configured model profiles |
| Provider requests fail | Check server logs, the key's access to the selected models, and provider quota |
| You can view but cannot edit | Accept a membership invitation; an ordinary workspace link grants viewing access |
| A review becomes stale | Refresh it and inspect the new candidate before applying |
| An attempt was interrupted | Inspect saved outputs and retry from the task details |

Further reading: [Account troubleshooting](docs/auth-debugging.md), [model adapter](apps/server/src/models/README.md), [orchestration](apps/server/src/orchestration/README.md), and [review evidence](apps/server/src/orchestration/REVIEW.md).

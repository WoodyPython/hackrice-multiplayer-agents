import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { BrowserSession } from "./session";
import { WorkspaceApi } from "./workspace-api";
import { workspace as sampleWorkspace } from "./fixtures";

/**
 * A04 and the unblocked half of A07.
 *
 * The properties worth the most here are the ones a screenshot cannot show:
 * that an answer goes to the answer endpoint rather than the comment endpoint,
 * that a retried post reuses its idempotency key, that a version conflict
 * preserves what was typed, and that the board claims nothing about agents it
 * cannot see.
 */

const workspaceId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000aa1";
const materialId = "30000000-0000-4000-8000-000000000bb1";
const draftFileId = "40000000-0000-4000-8000-000000000cc1";
const questionId = "50000000-0000-4000-8000-000000000dd1";
const at = "2026-09-12T10:00:00Z";

const workspace = { ...sampleWorkspace, id: workspaceId, isOwner: false };

const task = {
  id: taskId,
  workspaceId,
  kind: "agent_task",
  title: "Write a contributor guide",
  outcome: "New people can make a first change.",
  criteria: ["Include examples"],
  version: 2,
  status: "posted",
  manualSourcePath: null,
  creatorGuestLabel: "Guest Maple",
  outputPaths: ["docs/contributing.md"],
  activeRunId: null,
  discussionSeq: 1,
  inputs: [
    {
      id: "60000000-0000-4000-8000-000000000ee1",
      materialId,
      draftFileId: null,
      approvedPath: null,
      sourceVersion: null,
    },
  ],
  createdAt: at,
  updatedAt: at,
};

const summary = {
  ...task,
  materialCount: 1,
  openQuestionCount: 0,
};

const material = {
  id: materialId,
  workspaceId,
  filename: "brief.md",
  sha256: "a".repeat(64),
  byteSize: 2048,
  contentType: "text/plain",
  guestLabel: "Guest Maple",
  createdAt: at,
  deletedAt: null,
};

const draft = {
  id: draftFileId,
  taskId,
  path: "docs/contributing.md",
  epoch: 1,
  baseBlobSha: null,
  persistedRevision: 4,
  status: "active",
  updatedAt: at,
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  taskId,
  seq: 1,
  actorType: "guest",
  guestLabel: "Guest River",
  body: "Should this cover Windows too?",
  createdAt: at,
  materialIds: [],
  question: null,
  afterActiveRunCutoff: false,
  ...over,
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const fail = (code: string, status: number, details?: unknown) =>
  json({ error: { code, message: "not rendered", details } }, status);

type Call = { url: string; method: string; body: unknown };

/**
 * A routing fetch stub. Records every call so a test can assert which endpoint
 * an action reached, which is the only way to tell an answer from a comment.
 */
function server(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body;
    const call: Call = {
      url,
      method,
      body:
        typeof body === "string"
          ? JSON.parse(body)
          : body instanceof FormData
            ? Object.fromEntries(
                [...body.entries()].map(([k, v]) => [
                  k,
                  v instanceof File ? v.name : v,
                ]),
              )
            : undefined,
    };
    calls.push(call);
    const key = `${method} ${url.split("?")[0]!.replace(`/api/workspaces/${workspaceId}`, "")}`;
    const override = overrides[key];
    if (override) return override(call);
    switch (key) {
      case "GET ":
        return json(workspace);
      case "GET /tasks":
        return json({ tasks: [summary] });
      case `GET /tasks/${taskId}`:
        return json(task);
      case "GET /materials":
        return json({ materials: [material] });
      case "GET /drafts":
        return json({ drafts: [draft] });
      case `GET /tasks/${taskId}/discussion`:
        return json({ entries: [entry()], latestSeq: 1, activeRunCutoffSeq: null });
      case `GET /tasks/${taskId}/agents`:
        return json({ attempts: [] });
      case `GET /tasks/${taskId}/reviews`:
        return json({ reviews: [] });
      case `GET /tasks/${taskId}/drafts`:
        return json({ drafts: [draft] });
      case `GET /tasks/${taskId}/saved-outputs`:
        return json({ outputs: [] });
      case "GET /history":
        return json({ entries: [] });
      case `GET /tasks/${taskId}/events`:
        return json({ events: [], latestId: null });
      default:
        return json({}, 500);
    }
  }) as unknown as typeof fetch;
  return { transport, calls };
}

function open(path: string, transport: typeof fetch) {
  const session = new BrowserSession();
  const api = new WorkspaceApi(session, transport);
  render(
    <MemoryRouter initialEntries={[path]}>
      <Link to={`/w/${workspaceId}/tasks/20000000-0000-4000-8000-000000000aa2`}>Other task</Link>
      <App session={session} api={api} />
    </MemoryRouter>,
  );
  return { session, api };
}

beforeEach(() => {
  localStorage.clear();
});

describe("the board", () => {
  it("places live tasks by state without claiming anything about agents", async () => {
    const { transport } = server({
      "GET /tasks": () =>
        json({ tasks: [summary, { ...summary, id: "20000000-0000-4000-8000-000000000aa2", title: "Ship it", status: "working", activeRunId: "70000000-0000-4000-8000-000000000ff1" }] }),
    });
    open(`/w/${workspaceId}`, transport);

    const working = await screen.findByRole("region", { name: "Working" });
    expect(within(working).getByText("Ship it")).toBeTruthy();
    expect(
      within(await screen.findByRole("region", { name: "Posted" })).getByText(
        "Write a contributor guide",
      ),
    ).toBeTruthy();

    // §4.7 forbids fake progress. The API gives TaskSummary no assignment
    // summary, so no card may name an agent or a step. This assertion fails
    // against the copy this board shipped with ("Writer · preparing a first
    // draft"), which was rendered for every working task regardless of truth.
    expect(screen.queryByText(/Writer/)).toBeNull();
    expect(screen.queryByText(/first draft/)).toBeNull();
    expect(within(working).getByText("Agents are working")).toBeTruthy();
  });
});

describe("posting a task", () => {
  it("offers the workspace's real materials and drafts, and posts the selection", async () => {
    const user = userEvent.setup();
    const posted = { ...task, id: "20000000-0000-4000-8000-000000000aa9" };
    const { transport, calls } = server({
      "POST /tasks": () => json(posted, 201),
    });
    open(`/w/${workspaceId}/tasks/new`, transport);

    // Real names from the API, not the three invented IDs fixtures.ts carried.
    expect(await screen.findByText("brief.md")).toBeTruthy();
    expect(screen.getByText("docs/contributing.md")).toBeTruthy();

    await user.type(screen.getByLabelText(/Task title/), "Add a README");
    await user.click(screen.getByRole("checkbox", { name: /brief\.md/ }));
    await user.click(screen.getByRole("button", { name: "Post task" }));

    const post = await waitFor(() => {
      const found = calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"));
      expect(found).toBeTruthy();
      return found!;
    });
    const body = post.body as Record<string, unknown>;
    expect(body.title).toBe("Add a README");
    expect(body.inputs).toEqual([{ materialId }]);
    expect(typeof body.clientRequestId).toBe("string");
  });
});

describe("discussion", () => {
  it("labels entries the running attempt will never read", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}/discussion`]: () =>
        json({
          entries: [
            entry({ seq: 1, body: "In context" }),
            entry({ seq: 2, body: "Too late", afterActiveRunCutoff: true }),
          ],
          latestSeq: 2,
          activeRunCutoffSeq: 1,
        }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    expect(await screen.findByText("Too late")).toBeTruthy();
    // §2.3: a run's inputs freeze at Start. Without this label a contributor
    // cannot tell that what they just wrote reaches no agent in this run.
    expect(screen.getByText("Added after this run started")).toBeTruthy();
  });

  it("sends an answer to the question endpoint, never as an ordinary comment", async () => {
    const user = userEvent.setup();
    const asked = entry({
      seq: 2,
      actorType: "agent",
      guestLabel: null,
      body: "Which package manager should the guide assume?",
      question: { id: questionId, status: "open", role: "asked" },
    });
    const { transport, calls } = server({
      [`GET /tasks/${taskId}/discussion`]: () =>
        json({ entries: [asked], latestSeq: 2, activeRunCutoffSeq: 1 }),
      [`POST /tasks/${taskId}/answer`]: () =>
        json({
          question: {
            id: questionId,
            taskId,
            runId: "70000000-0000-4000-8000-000000000ff1",
            agentInstanceId: "80000000-0000-4000-8000-000000000aa1",
            questionEntryId: asked.id,
            answerEntryId: null,
            status: "answered",
            askedAt: at,
            expiresAt: at,
            resolvedAt: null,
          },
          answerEntry: entry({ seq: 3, body: "npm" }),
        }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    await user.type(
      await screen.findByLabelText("Answer this question"),
      "npm",
    );
    await user.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/answer"))).toBe(true),
    );
    const answer = calls.find((call) => call.url.endsWith("/answer"))!;
    expect((answer.body as Record<string, unknown>).questionId).toBe(questionId);
    // The same words posted as a comment would sit above the run's cutoff and
    // reach nobody. Routing matters more than the text.
    expect(
      calls.some(
        (call) => call.method === "POST" && call.url.endsWith("/discussion"),
      ),
    ).toBe(false);
  });

  it("keeps the typed comment and reuses its request id when a post fails", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { transport, calls } = server({
      [`POST /tasks/${taskId}/discussion`]: () => {
        attempts += 1;
        return attempts === 1
          ? fail("INTERNAL_ERROR", 500)
          : json(entry({ seq: 2, body: "Worth adding" }), 201);
      },
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    await user.type(
      await screen.findByLabelText("Add to the discussion"),
      "Worth adding",
    );
    await user.click(screen.getByRole("button", { name: "Post comment" }));

    // The text survives the failure, so a retry is one click rather than
    // retyping.
    await screen.findByRole("alert");
    expect(
      (screen.getByLabelText("Add to the discussion") as HTMLTextAreaElement)
        .value,
    ).toBe("Worth adding");

    await user.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(attempts).toBe(2));

    const posts = calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/discussion"),
    );
    // A retry must replay the original intent, not create a second entry.
    expect(posts).toHaveLength(2);
    expect((posts[0]!.body as Record<string, unknown>).clientRequestId).toBe(
      (posts[1]!.body as Record<string, unknown>).clientRequestId,
    );
  });
});

describe("starting and revising", () => {
  it("sends the expected version and one idempotency key for Start", async () => {
    const user = userEvent.setup();
    const { transport, calls } = server({
      [`POST /tasks/${taskId}/start`]: () =>
        json(
          {
            runId: "70000000-0000-4000-8000-000000000ff1",
            attempt: 1,
            taskStatus: "planning",
            idempotentReplay: false,
          },
          202,
        ),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    await user.click(await screen.findByRole("button", { name: "Start task" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/start"))).toBe(true),
    );
    const start = calls.find((call) => call.url.endsWith("/start"))!;
    expect((start.body as Record<string, unknown>).expectedVersion).toBe(2);
    expect(typeof (start.body as Record<string, unknown>).clientRequestId).toBe(
      "string",
    );
  });

  it("gives a Start after a cancel a new key, and a retried Start the same one", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const started = {
      runId: "70000000-0000-4000-8000-000000000ff1",
      attempt: 1,
      taskStatus: "planning",
      idempotentReplay: false,
    };
    const { transport, calls } = server({
      [`POST /tasks/${taskId}/start`]: () => {
        attempt += 1;
        // First click fails, second and third succeed.
        return attempt === 1 ? fail("INTERNAL_ERROR", 500) : json(started, 202);
      },
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    const click = async () =>
      user.click(await screen.findByRole("button", { name: "Start task" }));
    await click();
    await screen.findByRole("alert");
    await click();
    await waitFor(() => expect(attempt).toBe(2));
    await click();
    await waitFor(() => expect(attempt).toBe(3));

    const keys = calls
      .filter((call) => call.url.endsWith("/start"))
      .map((call) => (call.body as Record<string, unknown>).clientRequestId);
    expect(keys).toHaveLength(3);
    // Retry of a failed intent replays it...
    expect(keys[0]).toBe(keys[1]);
    // ...but a later Start is a new intent. Holding one key for the component's
    // lifetime would make this replay the earlier run and silently do nothing.
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("explains a version conflict without discarding the edit", async () => {
    const user = userEvent.setup();
    const { transport } = server({
      [`PATCH /tasks/${taskId}`]: () =>
        fail("TASK_VERSION_CHANGED", 409, { currentVersion: 3, expectedVersion: 2 }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    await user.click(
      await screen.findByRole("button", { name: "Edit requirements" }),
    );
    const title = await screen.findByLabelText(/Task title/);
    await user.clear(title);
    await user.type(title, "Renamed while someone else edited");
    await user.click(screen.getByRole("button", { name: "Save requirements" }));

    expect(
      await screen.findByText(/Someone else changed this task/),
    ).toBeTruthy();
    // Still on the form, still holding what was typed.
    expect((screen.getByLabelText(/Task title/) as HTMLInputElement).value).toBe(
      "Renamed while someone else edited",
    );
  });
});

describe("files", () => {
  it("rejects a binary before the request leaves the browser", async () => {
    const { transport, calls } = server();
    open(`/w/${workspaceId}/files`, transport);

    const picker = (await screen.findByLabelText(
      "Upload a material",
    )) as HTMLInputElement;
    // `accept` is a filter, not a guarantee: the OS dialog lets anyone switch
    // to "All files" and pick a PNG, and a drop bypasses it entirely. The file
    // is set directly rather than through user.upload, which honours `accept`
    // and would never reach the code under test.
    const png = new File([new Uint8Array([137, 80, 78, 71])], "diagram.png", {
      type: "image/png",
    });
    Object.defineProperty(picker, "files", { value: [png], configurable: true });
    fireEvent.change(picker);

    expect(await screen.findByRole("alert")).toBeTruthy();
    // Section 3.4 rejects binary server-side too; catching it here is what
    // stops the user finding out by dragging a PDF in and reading an error.
    expect(
      calls.some((call) => call.method === "POST" && call.url.endsWith("/materials")),
    ).toBe(false);
  });

  it("opens a shared document and lands in the editor for its task", async () => {
    const user = userEvent.setup();
    const { transport, calls } = server({
      "POST /drafts/open": () =>
        json({ taskId, draftFile: draft, created: false }, 200),
    });
    open(`/w/${workspaceId}/files`, transport);

    await user.type(await screen.findByLabelText("File path"), "docs/guide.md");
    await user.click(screen.getByRole("button", { name: "Edit together" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/drafts/open"))).toBe(true),
    );
    expect(await screen.findByRole("heading", { name: "Shared drafts" })).toBeTruthy();
  });

  it("says approved files are unavailable rather than showing an empty list", async () => {
    const { transport } = server();
    open(`/w/${workspaceId}/files`, transport);

    const approved = await screen.findByRole("heading", { name: "Approved files" });
    expect(approved).toBeTruthy();
    // Nothing can enumerate main. "No approved files" would be a claim we
    // cannot support; "not available yet" is the one we can.
    expect(screen.getByText("Not available yet")).toBeTruthy();
  });
});

const runId = "70000000-0000-4000-8000-000000000ff1";

const assignment = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  runId,
  taskId,
  agentKey: "facts",
  assignmentKey: "facts",
  preset: "analyst",
  status: "completed",
  instructionSummary: "Extract the facts.",
  writePaths: [],
  dependsOn: [],
  baseSha: null,
  resultSha: null,
  startedAt: at,
  deadlineAt: null,
  endedAt: at,
  ...over,
});

const attempt = (over: Record<string, unknown> = {}) => ({
  runId,
  attempt: 1,
  status: "working",
  taskVersion: 2,
  createdAt: at,
  endedAt: null,
  assignments: [],
  ...over,
});

let eventSequence = 0;
const startEvent = (reason: string, payload: Record<string, unknown> = {}) => ({
  id: String(++eventSequence),
  taskId,
  runId,
  type: "agent.waiting",
  payload: { phase: "start", reason, ...payload },
  createdAt: at,
});

describe("agent progress", () => {
  async function openAgents(overrides: Parameters<typeof server>[0]) {
    const user = userEvent.setup();
    const { transport, calls } = server(overrides);
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    await user.click(await screen.findByRole("tab", { name: "Agents" }));
    return { user, calls };
  }

  it("lays assignments out in dependency waves so parallel work is visible", async () => {
    const facts = assignment({ assignmentKey: "facts" });
    const faq = assignment({ assignmentKey: "faq", preset: "writer", dependsOn: [facts.id], writePaths: ["documents/faq.md"] });
    const announce = assignment({ assignmentKey: "announce", preset: "writer", dependsOn: [facts.id], writePaths: ["documents/announce.md"] });
    const review = assignment({ assignmentKey: "review", preset: "reviewer", dependsOn: [faq.id, announce.id] });
    await openAgents({
      [`GET /tasks/${taskId}/agents`]: () =>
        json({ attempts: [attempt({ assignments: [facts, faq, announce, review] })] }),
    });

    // §4.5: "Parallel workers are visibly distinct." faq and announce depend on
    // facts and on nothing else, so they are the one wave that can run at once.
    expect(await screen.findByText("2 in parallel")).toBeTruthy();
    expect(screen.getByText("documents/faq.md")).toBeTruthy();
    expect(screen.getByText("documents/announce.md")).toBeTruthy();
  });

  it("keeps a failed attempt inspectable after a retry", async () => {
    await openAgents({
      [`GET /tasks/${taskId}/agents`]: () =>
        json({
          attempts: [
            attempt({ attempt: 2, assignments: [assignment({ assignmentKey: "second" })] }),
            attempt({ runId: "70000000-0000-4000-8000-000000000ff2", attempt: 1, status: "incomplete", endedAt: at,
                      assignments: [assignment({ assignmentKey: "first", status: "timed_out" })] }),
          ],
        }),
    });

    // §4.7: an incomplete task shows preserved output. A retry must not make
    // the earlier attempt's work unreachable.
    expect(await screen.findByRole("region", { name: "Attempt 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Attempt 2" })).toBeTruthy();
    expect(screen.getByText("timed out")).toBeTruthy();
  });

  it("says no attempt has run rather than implying agents failed", async () => {
    await openAgents({});
    expect(await screen.findByText("No attempt has run yet")).toBeTruthy();
  });
});

describe("why an attempt ended", () => {
  it("names the files behind a snapshot conflict without showing the raw code", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}`]: () => json({ ...task, status: "conflict" }),
      [`GET /tasks/${taskId}/events`]: () =>
        json({
          events: [startEvent("context_captured"), startEvent("snapshot_conflict", { paths: ["documents/faq.md"] })],
          latestId: String(eventSequence),
        }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    expect(
      await screen.findByText(/could not be combined/),
    ).toBeTruthy();
    expect(screen.getByText("documents/faq.md")).toBeTruthy();
    // The interface note is explicit: never show these codes raw as the
    // primary message. They are stable identifiers, not copy.
    expect(screen.queryByText("snapshot_conflict")).toBeNull();
  });

  it("surfaces inputs that were selected but never reached the agents", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}/events`]: () =>
        json({
          events: [startEvent("context_captured", { omitted: ["brief.md"] })],
          latestId: String(eventSequence),
        }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    // The easiest payload to ignore and the most damaging to: without it a
    // contributor believes the agents read a document they never saw.
    expect(await screen.findByText(/were not included/)).toBeTruthy();
    expect(screen.getByText("brief.md")).toBeTruthy();
  });

  it("still explains an unrecognised reason instead of rendering nothing", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}`]: () => json({ ...task, status: "incomplete" }),
      [`GET /tasks/${taskId}/events`]: () =>
        json({ events: [startEvent("some_reason_added_later")], latestId: String(eventSequence) }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    // "the codes are stable, the set is not closed" — a new one must not
    // render as a blank panel.
    expect(await screen.findByText("This attempt did not complete")).toBeTruthy();
  });

  it("shows no outcome panel while the attempt is still running", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}`]: () => json({ ...task, status: "working", activeRunId: runId }),
      [`GET /tasks/${taskId}/events`]: () =>
        json({ events: [startEvent("context_captured")], latestId: String(eventSequence) }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);

    await screen.findByRole("tab", { name: "Agents" });
    expect(screen.queryByText(/did not complete/)).toBeNull();
  });
});

const reviewId = "80000000-0000-4000-8000-000000000bb9";
const candidateSha = "a".repeat(40);
const DIFF = ["@@ -1 +1 @@", "-old", "+new"].join("\n");

const reviewRow = (over: Record<string, unknown> = {}) => ({
  id: reviewId,
  taskId,
  runId: null,
  source: {
    taskVersion: 2, guidanceVersion: 1, mainSha: "b".repeat(40),
    humanSha: "c".repeat(40), resultSha: null, documentRevisions: {},
    contextHash: "ctx",
  },
  candidateSha,
  status: "ready",
  createdAt: at,
  updatedAt: at,
  ...over,
});

const reviewDetail = (over: Record<string, unknown> = {}) => ({
  candidateSha,
  candidateComplete: true,
  conflicts: [],
  changedFiles: [
    { path: "docs/contributing.md", changeKind: "modified", diff: DIFF, beforeHash: "d".repeat(40), afterHash: "e".repeat(40) },
  ],
  generatedCodeWasNotExecuted: true,
  review: reviewRow(),
  ...over,
});

/** Renders the Changes tab as owner unless told otherwise. */
async function openChanges(
  overrides: Parameters<typeof server>[0],
  owner = true,
) {
  const user = userEvent.setup();
  const session = new BrowserSession();
  if (owner) session.saveOwner(workspaceId, "owner-key-for-tests-1234567890");
  const { transport, calls } = server({
    "GET ": () => json({ ...workspace, isOwner: owner }),
    ...overrides,
  });
  const api = new WorkspaceApi(session, transport);
  render(
    <MemoryRouter initialEntries={[`/w/${workspaceId}/tasks/${taskId}`]}>
      <App session={session} api={api} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole("tab", { name: "Changes" }));
  return { user, calls };
}

describe("review", () => {
  it("offers to prepare one rather than claiming there are no changes", async () => {
    const { user, calls } = await openChanges({});
    expect(await screen.findByText("No review has been requested yet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Prepare review" }));
    // Nothing prepares a review automatically, so the absence of one is not
    // evidence that the work produced no changes.
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/review"))).toBe(true),
    );
  });

  it("shows the diff and lets an owner apply the candidate it is looking at", async () => {
    const { user, calls } = await openChanges({
      [`GET /tasks/${taskId}/reviews`]: () => json({ reviews: [reviewRow()] }),
      [`GET /reviews/${reviewId}`]: () => json(reviewDetail()),
      [`POST /reviews/${reviewId}/apply`]: () =>
        json({ status: "applied", appliedCommitSha: candidateSha, alreadyApplied: false }),
    });

    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("docs/contributing.md")).toBeTruthy();
    expect(within(panel).getByText("modified")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Apply these changes" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true),
    );
    const apply = calls.find((c) => c.url.endsWith("/apply"))!;
    // Sending the SHA we rendered is what stops a browser applying a candidate
    // that moved underneath it.
    expect((apply.body as Record<string, unknown>).candidateSha).toBe(candidateSha);
  });

  it("hides Apply from a contributor but still shows the changes", async () => {
    await openChanges(
      {
        [`GET /tasks/${taskId}/reviews`]: () => json({ reviews: [reviewRow()] }),
        [`GET /reviews/${reviewId}`]: () => json(reviewDetail()),
      },
      false,
    );

    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("docs/contributing.md")).toBeTruthy();
    // Presentation only -- the server checks the key on every apply. §4.6:
    // "hiding a button is insufficient."
    expect(screen.queryByRole("button", { name: "Apply these changes" })).toBeNull();
    expect(screen.getByText(/Only the workspace owner can apply/)).toBeTruthy();
  });

  it("blocks Apply on a stale review and offers a refresh", async () => {
    await openChanges({
      [`GET /tasks/${taskId}/reviews`]: () => json({ reviews: [reviewRow({ status: "stale" })] }),
      [`GET /reviews/${reviewId}`]: () => json(reviewDetail({ review: reviewRow({ status: "stale" }) })),
    });

    // §4.7: "Review stale | Disable Apply and offer Refresh review".
    expect(await screen.findByText("This review is out of date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply these changes" })).toBeNull();
  });

  it("names each conflicting side and refuses Apply until every file is decided", async () => {
    const conflicted = reviewDetail({
      review: reviewRow({ status: "ready" }),
      conflicts: [
        {
          path: "docs/contributing.md",
          stage: "human_agent",
          sides: [
            { side: "human_draft", text: "what people wrote", sha: "f".repeat(40) },
            { side: "agent_result", text: "what the agent wrote", sha: "0".repeat(40) },
          ],
        },
      ],
    });
    const { user, calls } = await openChanges({
      [`GET /tasks/${taskId}/reviews`]: () => json({ reviews: [reviewRow()] }),
      [`GET /reviews/${reviewId}`]: () => json(conflicted),
      [`POST /reviews/${reviewId}/resolve`]: () => json(reviewDetail()),
    });

    // §10.2: never label both sides "ours". Each one says which source it is.
    expect(await screen.findByText("What people wrote in the shared draft")).toBeTruthy();
    expect(screen.getByText("What the agents produced")).toBeTruthy();
    // A conflicted candidate must not be publishable.
    expect(
      (screen.getByRole("button", { name: "Apply these changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole("radio", { name: /What people wrote/ }));
    await user.click(screen.getByRole("button", { name: "Use these versions" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/resolve"))).toBe(true),
    );
    const resolve = calls.find((c) => c.url.endsWith("/resolve"))!;
    const body = resolve.body as { expectedCandidateSha: string; resolutions: unknown[] };
    // Resolving builds a NEW candidate, so the one being replaced is named.
    expect(body.expectedCandidateSha).toBe(candidateSha);
    expect(body.resolutions).toEqual([
      { path: "docs/contributing.md", choice: "human_draft" },
    ]);
  });

  it("does not read a candidate for a review that is still building", async () => {
    const { calls } = await openChanges({
      [`GET /tasks/${taskId}/reviews`]: () =>
        json({ reviews: [reviewRow({ status: "building", candidateSha: null })] }),
    });

    expect(await screen.findByText(/still being built/)).toBeTruthy();
    // Reading it means reading a Git artifact that does not exist yet, which
    // the server answers with INVALID_STATE.
    expect(calls.some((c) => c.url.endsWith(`/reviews/${reviewId}`))).toBe(false);
  });
});

describe("the shared editor", () => {
  async function openEditor(overrides: Parameters<typeof server>[0] = {}) {
    const user = userEvent.setup();
    const { transport, calls } = server(overrides);
    open(`/w/${workspaceId}/tasks/${taskId}/drafts`, transport);
    await screen.findByRole("heading", { name: "Shared drafts" });
    return { user, calls };
  }

  it("holds Checkpoint and Request review until the text is saved", async () => {
    await openEditor();
    // §4.4: Saved means persisted, and capture takes the acknowledged text.
    // Checkpointing before then would commit a version nobody has seen.
    expect(
      (await screen.findByRole("button", { name: "Checkpoint" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Request review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Unsaved/)).toBeTruthy();
  });

  it("links back to the task, not the workspace", async () => {
    await openEditor();
    // §4.4 asks for a link back to the task: that is where this text is
    // discussed and reviewed.
    const back = await screen.findByRole("link", { name: /Back to the task/ });
    expect(back.getAttribute("href")).toBe(`/w/${workspaceId}/tasks/${taskId}`);
  });

  it("distinguishes checkpointed from approved", async () => {
    await openEditor();
    // "Checkpointed" means captured in Git. §4.4: neither Saved nor
    // Checkpointed means approved, and the copy has to carry that.
    expect(await screen.findByText(/Not checkpointed yet/)).toBeTruthy();
  });
});

describe("deep links", () => {
  it("opens the tab a link names, and ignores one that does not exist", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}/reviews`]: () => json({ reviews: [] }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}?tab=Changes`, transport);

    // Request review says it will show you the review; this is what makes that
    // true rather than landing on the task and leaving the reader to hunt.
    expect(
      (await screen.findByRole("tab", { name: "Changes" })).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("falls back to Discussion for a tab name that is not real", async () => {
    const { transport } = server();
    open(`/w/${workspaceId}/tasks/${taskId}?tab=Nonsense`, transport);
    expect(
      (await screen.findByRole("tab", { name: "Discussion" })).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

afterEach(() => vi.useRealTimers());

describe("task refresh regressions", () => {
  it("retries through the actual response schema and reuses an uncertain intent", async () => {
    let requests = 0;
    let current = { ...task, status: "incomplete", activeRunId: null as string | null };
    const { transport, calls } = server({
      [`GET /tasks/${taskId}`]: () => json(current),
      [`POST /tasks/${taskId}/retry`]: () => {
        if (++requests === 1) return fail("INTERNAL_ERROR", 500);
        current = { ...current, status: "planning", activeRunId: "70000000-0000-4000-8000-000000000ff1" };
        return json({ runId: current.activeRunId, attempt: 2, taskStatus: "planning", idempotentReplay: true }, 202);
      },
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    fireEvent.click(await screen.findByRole("button", { name: "Retry from saved work" }));
    await screen.findByText(/We could not confirm the request/);
    fireEvent.click(screen.getByRole("button", { name: "Retry from saved work" }));
    await screen.findByRole("button", { name: "Stop this attempt" });
    const retryCalls = calls.filter((call) => call.url.endsWith("/retry"));
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]!.body).toEqual(retryCalls[1]!.body);
    expect(screen.queryByText(/We could not confirm the request/)).toBeNull();
  });

  it("pins the edit version and selected identities across a poll", async () => {
    let current = task;
    let materials = [material];
    const { transport, calls } = server({
      [`GET /tasks/${taskId}`]: () => json(current),
      "GET /materials": () => json({ materials }),
      [`PATCH /tasks/${taskId}`]: () => fail("TASK_VERSION_CHANGED", 409),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    fireEvent.click(await screen.findByRole("button", { name: "Edit requirements" }));
    fireEvent.change(screen.getByLabelText(/Task title/), { target: { value: "My retained edit" } });
    vi.useFakeTimers();
    // The initial poll was scheduled with real timers; a failed save forces a new pull using fake timers.
    fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    current = { ...task, version: 3, title: "Other user's edit" };
    materials = [{ ...material, id: "30000000-0000-4000-8000-000000000bb2", filename: "new.md" }, material];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const saves = calls.filter((call) => call.method === "PATCH");
    expect(saves).toHaveLength(2);
    expect(saves[1]!.body).toMatchObject({ expectedVersion: 2, title: "My retained edit", inputs: [{ materialId }] });
    expect((screen.getByLabelText(/Task title/) as HTMLInputElement).value).toBe("My retained edit");
  });

  it("clears old editing state immediately when the task route changes", async () => {
    const { transport } = server();
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    fireEvent.click(await screen.findByRole("button", { name: "Edit requirements" }));
    fireEvent.change(screen.getByLabelText(/Task title/), { target: { value: "Old task edit" } });
    fireEvent.click(screen.getByRole("link", { name: "Other task" }));
    expect(screen.queryByRole("button", { name: "Save requirements" })).toBeNull();
    await screen.findByText("Could not load this task");
  });

  it("lets contributors stop an active run even when task status is incomplete", async () => {
    const { transport } = server({ [`GET /tasks/${taskId}`]: () => json({ ...task, status: "incomplete", activeRunId: "70000000-0000-4000-8000-000000000ff1" }) });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    await screen.findByRole("button", { name: "Stop this attempt" });
    expect(screen.queryByRole("button", { name: "Retry from saved work" })).toBeNull();

});
});

const historyEntry = (over: Record<string, unknown> = {}) => ({
  applyOperationId: crypto.randomUUID(),
  reviewId,
  taskId,
  taskTitle: "Write a contributor guide",
  taskKind: "agent_task",
  candidateSha,
  status: "applied",
  requestedAt: at,
  settledAt: at,
  ...over,
});

describe("history", () => {
  it("lists applied changes with the task each came from", async () => {
    const { transport } = server({ "GET /history": () => json({ entries: [historyEntry()] }) });
    open(`/w/${workspaceId}/history`, transport);

    const link = await screen.findByRole("link", { name: "Write a contributor guide" });
    // §4.1: "Applied changes and associated tasks" -- the task is half of it.
    expect(link.getAttribute("href")).toBe(`/w/${workspaceId}/tasks/${taskId}?tab=Changes`);
    expect(screen.getByText("Applied")).toBeTruthy();
  });

  it("shows an apply that did not succeed rather than hiding it", async () => {
    const { transport } = server({
      "GET /history": () => json({ entries: [historyEntry({ status: "ambiguous", settledAt: null })] }),
    });
    open(`/w/${workspaceId}/history`, transport);

    // §10.5 keeps these states distinguishable on purpose. A stuck apply must
    // not be invisible in the one screen meant to say what happened.
    expect(await screen.findByText("Needs checking")).toBeTruthy();
    expect(screen.getByText(/could not be determined/)).toBeTruthy();
  });

  it("says nothing has been applied rather than showing a bare empty list", async () => {
    const { transport } = server();
    open(`/w/${workspaceId}/history`, transport);
    expect(await screen.findByText("Nothing has been applied yet")).toBeTruthy();
  });
});

describe("retrying with saved work", () => {
  const savedOutput = {
    agentInstanceId: "90000000-0000-4000-8000-000000000aa1",
    path: "documents/faq.md",
    runId,
    commitSha: "f".repeat(40),
  };

  async function openIncomplete(outputs = [savedOutput]) {
    const user = userEvent.setup();
    const { transport, calls } = server({
      [`GET /tasks/${taskId}`]: () => json({ ...task, status: "incomplete" }),
      [`GET /tasks/${taskId}/saved-outputs`]: () => json({ outputs }),
      [`POST /tasks/${taskId}/retry`]: () =>
        json({ runId, attempt: 2, taskStatus: "planning", idempotentReplay: false }, 202),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    await screen.findByRole("region", { name: "Saved work" });
    return { user, calls };
  }

  it("keeps finished work by default and sends identities, not commit SHAs", async () => {
    const { user, calls } = await openIncomplete();
    expect(
      (screen.getByRole("checkbox", { name: /documents\/faq\.md/ }) as HTMLInputElement).checked,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retry from saved work" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/retry"))).toBe(true));

    const body = calls.find((c) => c.url.endsWith("/retry"))!.body as Record<string, unknown>;
    // C08 resolves the commit under the task lock; a client-supplied SHA is
    // never accepted, so it must not be sent.
    expect(body.savedOutputs).toEqual([
      { agentInstanceId: savedOutput.agentInstanceId, path: savedOutput.path },
    ]);
    expect(JSON.stringify(body)).not.toContain(savedOutput.commitSha);
  });

  it("lets the selection be cleared, and says what that means", async () => {
    const { user, calls } = await openIncomplete();
    await user.click(screen.getByRole("checkbox", { name: /documents\/faq\.md/ }));
    expect(screen.getByText(/will redo all of this/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry from saved work" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/retry"))).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/retry"))!.body as Record<string, unknown>;
    expect(body.savedOutputs).toEqual([]);
  });

  it("shows no saved-work panel when the last attempt finished nothing", async () => {
    const { transport } = server({
      [`GET /tasks/${taskId}`]: () => json({ ...task, status: "incomplete" }),
    });
    open(`/w/${workspaceId}/tasks/${taskId}`, transport);
    await screen.findByRole("button", { name: "Retry from saved work" });
    expect(screen.queryByRole("region", { name: "Saved work" })).toBeNull();
  });
});

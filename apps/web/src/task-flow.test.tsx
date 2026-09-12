import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

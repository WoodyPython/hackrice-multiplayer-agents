import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  BRIEFING_SESSION_HEADER,
  OWNER_KEY_HEADER,
  briefingSchema,
  type Briefing,
} from "@app/contracts";
import { App } from "./App";
import { BRIEFING_SESSION_STORAGE_KEY, BrowserSession } from "./session";
import { WorkspaceApi } from "./workspace-api";
import { workspace as sample } from "./fixtures";

const id = "abcdef01-0000-4000-8000-0000000000aa";
const taskId = "abcdef01-0000-4000-8000-0000000000b1";
const draftTaskId = "abcdef01-0000-4000-8000-0000000000b2";
const reviewId = "abcdef01-0000-4000-8000-0000000000c1";
const ownerKey = "test-only-owner-secret-123456789";
const workspace = { ...sample, id, name: "Team room" };
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const errorResponse = (code: string, status: number) =>
  response({ error: { code, message: "Server text is not rendered" } }, status);

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return briefingSchema.parse({
    id: "abcdef01-0000-4000-8000-0000000000d1",
    window: "last_hour",
    since: "2026-09-13T09:00:00.000Z",
    until: "2026-09-13T10:00:00.000Z",
    previousCutoff: null,
    firstBriefing: true,
    source: "gemini",
    fallbackReason: null,
    stats: { updates: 4, tasksTouched: 2, comments: 2, applied: 1, openQuestions: 1, unresolvedReviews: 1 },
    changes: [{
      text: "The launch post is ready to review and its copy was applied.",
      at: "2026-09-13T09:50:00.000Z",
      links: [
        { kind: "task", taskId, label: "Write the launch post" },
        { kind: "review", taskId, reviewId, label: "Review of Write the launch post" },
        { kind: "file", path: "docs/launch plan.md", approved: true, taskId: null, label: "docs/launch plan.md" },
      ],
    }],
    needsAttention: [{
      kind: "question", text: "An agent is waiting for an answer on “Draft the FAQ”: Which regions?",
      at: "2026-09-13T09:40:00.000Z", links: [{ kind: "task", taskId: draftTaskId, label: "Draft the FAQ" }],
    }],
    nextSteps: [{
      text: "Answer the open question on the FAQ.", at: null,
      links: [{ kind: "file", path: "docs/faq.md", approved: false, taskId: draftTaskId, label: "docs/faq.md" }],
    }],
    activity: [
      { text: "“Write the launch post” was posted", at: "2026-09-13T09:10:00.000Z", links: [{ kind: "task", taskId, label: "Write the launch post" }] },
    ],
    cutoffAdvanced: false,
    generatedAt: "2026-09-13T10:00:00.000Z",
    ...overrides,
  });
}

type Route = (init: RequestInit) => Response | Promise<Response>;

function fixture(routes: { list?: Route; generate?: Route }, session = new BrowserSession()) {
  const transport = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url === `/api/workspaces/${id}`) return response(workspace);
    if (url === `/api/workspaces/${id}/briefings` && init.method === "GET")
      return (routes.list ?? (() => response({ cutoff: null, briefings: [] })))(init);
    if (url === `/api/workspaces/${id}/briefings` && init.method === "POST")
      return (routes.generate ?? (() => response(briefing())))(init);
    return errorResponse("VALIDATION_FAILED", 404);
  });
  const api = new WorkspaceApi(session, transport);
  render(
    <MemoryRouter initialEntries={[`/w/${id}/overview`]}>
      <App session={session} api={api} />
    </MemoryRouter>,
  );
  return { transport, session };
}

const catchMeUp = () => screen.findByRole("button", { name: "Catch me up" });

beforeEach(() => {
  localStorage.clear();
});

describe("Overview: catch me up", () => {
  it("adds Overview to the workspace sidebar and starts ready, with no briefing history", async () => {
    fixture({});
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("href")).toBe(`/w/${id}/overview`);
    expect(within(nav).getByRole("link", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("Ready when you are")).toBeTruthy();
    expect(await screen.findByText("No briefings yet. Your first one will appear here.")).toBeTruthy();
    expect(screen.getByText("No earlier briefing in this browser yet, so this covers the last 24 hours.")).toBeTruthy();
  });

  it("shows loading, then a briefing whose links point at real records", async () => {
    const user = userEvent.setup();
    let release!: (value: Response) => void;
    const session = new BrowserSession();
    session.saveOwner(id, ownerKey);
    const { transport } = fixture({
      generate: () => new Promise<Response>((resolve) => { release = resolve; }),
    }, session);

    await user.click(await screen.findByRole("radio", { name: "Last hour" }));
    await user.click(await catchMeUp());
    expect(screen.getByText(/Reading the workspace records/).getAttribute("role")).toBe("status");
    expect((screen.getByRole("button", { name: "Catching you up…" }) as HTMLButtonElement).disabled).toBe(true);

    release(response(briefing()));
    expect(await screen.findByText("4 updates across 2 tasks · 2 waiting on someone")).toBeTruthy();
    expect(screen.getByText("Generated with Gemini")).toBeTruthy();
    expect(screen.getByText("The launch post is ready to review and its copy was applied.")).toBeTruthy();

    const changes = screen.getByText("The launch post is ready to review and its copy was applied.").closest("li")!;
    const hrefs = within(changes).getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      `/w/${id}/tasks/${taskId}`,
      `/w/${id}/tasks/${taskId}?tab=Changes`,
      `/w/${id}/files/view?path=docs%2Flaunch%20plan.md`,
    ]);
    const step = screen.getByText("Answer the open question on the FAQ.").closest("li")!;
    expect(within(step).getByRole("link").getAttribute("href")).toBe(`/w/${id}/tasks/${draftTaskId}/drafts`);
    expect(screen.getByText("Suggestions only. Nothing is done automatically.")).toBeTruthy();
    expect(screen.getByText(/Which regions\?/)).toBeTruthy();

    const post = transport.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ window: "last_hour" });
    const headers = post[1]!.headers as Record<string, string>;
    expect(headers[BRIEFING_SESSION_HEADER]).toBe(localStorage.getItem(BRIEFING_SESSION_STORAGE_KEY));
    expect(headers[BRIEFING_SESSION_HEADER]).not.toBe(session.getGuest().contributorId);
    // A briefing reads what any link holder can; the owner key stays home.
    expect(headers).not.toHaveProperty(OWNER_KEY_HEADER);

    // Stored briefings join this browser's history.
    const aside = screen.getByRole("complementary", { name: "Earlier briefings" });
    expect(within(aside).getByRole("button", { current: true })).toBeTruthy();
  });

  it("labels the factual recap when Gemini is unavailable and offers no suggestions", async () => {
    const user = userEvent.setup();
    fixture({
      generate: () => response(briefing({ id: null, source: "fallback", fallbackReason: "model_failed", nextSteps: [],
        changes: [{ text: "“Write the launch post” was posted", at: "2026-09-13T09:10:00.000Z", links: [] }] })),
    });
    await user.click(await catchMeUp());
    expect(await screen.findByText("The AI summary is unavailable right now")).toBeTruthy();
    expect(screen.getByText("Activity recap")).toBeTruthy();
    expect(screen.getByText(/Gemini did not respond in time/)).toBeTruthy();
    expect(screen.queryByText("Suggested next steps")).toBeNull();
    expect(screen.getByText("“Since last briefing” was not moved, so the next briefing covers this time again.")).toBeTruthy();
    expect(screen.getByText("No briefings yet. Your first one will appear here.")).toBeTruthy();
  });

  it("shows an empty state when nothing changed, while still listing what is waiting", async () => {
    const user = userEvent.setup();
    fixture({
      generate: () => response(briefing({ id: null, source: "empty", changes: [], nextSteps: [], activity: [],
        stats: { updates: 0, tasksTouched: 0, comments: 0, applied: 0, openQuestions: 1, unresolvedReviews: 0 } })),
    });
    await user.click(await catchMeUp());
    expect(await screen.findByText("Nothing changed in this window")).toBeTruthy();
    expect(screen.getByText("You're all caught up")).toBeTruthy();
    expect(screen.getByText(/Which regions\?/)).toBeTruthy();
    expect(screen.queryByText("What changed")).toBeNull();
  });

  it("recovers from a failed request, and explains throttling", async () => {
    const user = userEvent.setup();
    const replies = [errorResponse("INTERNAL_ERROR", 500), errorResponse("RATE_LIMITED", 429), response(briefing())];
    fixture({ generate: () => replies.shift()! });
    await user.click(await catchMeUp());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We could not reach the server");
    expect(alert.textContent).not.toContain("Server text");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("alert")).textContent).toContain("requested too often");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Generated with Gemini")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reopens an earlier briefing from this browser's history and shows the cutoff", async () => {
    const user = userEvent.setup();
    const earlier = briefing({ window: "since_last", cutoffAdvanced: true, generatedAt: "2026-09-12T08:00:00.000Z" });
    fixture({ list: () => response({ cutoff: "2026-09-12T08:00:00.000Z", briefings: [earlier] }) });
    const aside = await screen.findByRole("complementary", { name: "Earlier briefings" });
    await user.click(await within(aside).findByRole("button", { name: /Since last briefing · 4 updates/ }));
    expect(screen.getByText("Earlier briefing")).toBeTruthy();
    expect(screen.getByText(/Everything since your last briefing at/)).toBeTruthy();
    await waitFor(() => expect(within(aside).getByRole("button", { current: true })).toBeTruthy());
  });

  it("keeps one private briefing session key per browser", () => {
    const first = new BrowserSession().getBriefingSessionKey();
    expect(new BrowserSession().getBriefingSessionKey()).toBe(first);
    const noStorage = new BrowserSession(() => { throw new Error("blocked"); });
    const key = noStorage.getBriefingSessionKey();
    expect(noStorage.getBriefingSessionKey()).toBe(key);
    expect(key).not.toBe(first);
  });
});

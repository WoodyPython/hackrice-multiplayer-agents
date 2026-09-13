import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type Membership, type SessionState, type WorkspaceDirectory } from "@app/contracts";
import { App } from "./App";
import { BrowserSession } from "./session";
import { WorkspaceApi } from "./workspace-api";
import type { AuthApi } from "./auth-api";
import { workspace as sample } from "./fixtures";
import { relativeTime } from "./lib/utils";

/**
 * Getting back to a workspace, from any device.
 *
 * The property under test across this file: a person's way back in comes from
 * their account, not from a URL they kept. Before accounts the workspace row
 * was always there -- it has been a Postgres row since the first migration --
 * but the only route to it was a link in a chat or a tab left open, so losing
 * that lost the room.
 */

const idA = "aaaaaaa1-0000-4000-8000-000000000001";
const idB = "bbbbbbb1-0000-4000-8000-000000000002";
const idC = "ccccccc1-0000-4000-8000-000000000003";
const idLink = "ddddddd1-0000-4000-8000-000000000004";

const hourAgo = new Date(Date.now() - 3600_000).toISOString();
const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

const mine: Membership[] = [
  { workspaceId: idA, name: "Launch room", role: "owner", joinedAt: weekAgo,
    lastActivityAt: hourAgo, archived: false, memberCount: 3, openTaskCount: 2 },
  { workspaceId: idB, name: "Docs rewrite", role: "member", joinedAt: weekAgo,
    lastActivityAt: weekAgo, archived: false, memberCount: 1, openTaskCount: 0 },
  { workspaceId: idC, name: "Old campaign", role: "owner", joinedAt: weekAgo,
    lastActivityAt: weekAgo, archived: true, memberCount: 2, openTaskCount: 0 },
];

const directory: WorkspaceDirectory = {
  workspaces: mine,
  visited: [{ workspaceId: idLink, name: "Someone else's room", lastSeenAt: hourAgo }],
};

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function authApi(overrides: Partial<SessionState> = {}, dir = directory): AuthApi {
  const state: SessionState = {
    account: { id: "acc-1", email: "ada@example.test", displayName: "Ada Lovelace" },
    workspaces: dir.workspaces,
    preferences: { theme: "system", lastWorkspace: null },
    ...overrides,
  };
  return {
    configured: true,
    current: async () => state,
    signOut: async () => {},
    savePreferences: async () => state.preferences!,
    directory: async () => dir,
    members: async () => [],
    invitations: async () => [],
    leaveWorkspace: async () => {},
  } as unknown as AuthApi;
}

function open(path: string, api: AuthApi, transport?: typeof fetch) {
  const session = new BrowserSession();
  const workspaceApi = new WorkspaceApi(session, transport ??
    ((input) => Promise.resolve(response(String(input).endsWith("/inbox")
      ? { items: [] }
      : { ...sample, id: idA, name: "Launch room", access: "owner", isOwner: true }))));
  render(
    <MemoryRouter initialEntries={[path]}>
      <App session={session} api={workspaceApi} authApi={api} />
    </MemoryRouter>,
  );
}

describe("home", () => {
  it("lists the workspaces you belong to, newest activity first", async () => {
    open("/", authApi());
    const section = (await screen.findByText("Your workspaces")).closest("section")!;
    const names = within(section).getAllByRole("link").map((link) => link.textContent ?? "");
    // Activity order, not alphabetical: "Docs rewrite" sorts first by name and
    // last by use, and the one somebody wants is the one they were just in.
    expect(names[0]).toContain("Launch room");
    expect(names[1]).toContain("Docs rewrite");
    // The archived one is in its own section, not this list.
    expect(section.textContent).not.toContain("Old campaign");
  });

  it("separates workspaces you only have the link to, and says they are read-only", async () => {
    open("/", authApi());
    const section = (await screen.findByText("Opened by link")).closest("section")!;
    expect(section.textContent).toContain("Someone else's room");
    // The list restores the address, never the access. Saying so on the row is
    // the difference between a useful shortcut and an implied promotion.
    expect(section.textContent).toContain("View only");
  });

  it("gives archived workspaces their own section rather than dropping them", async () => {
    open("/", authApi());
    // "Archived" is also the badge on each row, so target the heading.
    const section = (await screen.findByRole("heading", { name: /^Archived/ }))
      .closest("section")!;
    expect(section.textContent).toContain("Old campaign");
    // A list that silently loses a workspace reads as data loss, which is the
    // opposite of what archiving is for.
    expect(within(section).getByRole("link").getAttribute("href")).toContain(idC);
  });

  it("offers the last workspace, without redirecting into it", async () => {
    open("/", authApi({ preferences: { theme: "system", lastWorkspace: idB } }));
    const resume = await screen.findByText("Pick up where you left off");
    expect(resume.closest("a")!.getAttribute("href")).toContain(idB);
    // Offered, not performed: somebody who opened the home page may well have
    // come for a different workspace, and a redirect takes that choice away.
    expect(screen.getByText("Your workspaces")).toBeTruthy();
  });

  it("shows a returning person their account, not a guest label", async () => {
    open("/", authApi());
    expect(await screen.findByText(/Welcome back, Ada/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Guest (Cedar|Maple|River|Finch)/);
  });

  it("explains what a workspace is when there are none, instead of an empty list", async () => {
    open("/", authApi({ workspaces: [] }, { workspaces: [], visited: [] }));
    expect(await screen.findByText("No workspaces yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create your first workspace/ })).toBeTruthy();
  });

  it("keeps the list on screen when a refresh fails, and says it could not refresh", async () => {
    const failing = {
      ...authApi(),
      directory: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as AuthApi;
    open("/", failing);
    // A failed read is not evidence of having no workspaces, and telling
    // somebody their teams are gone because a request timed out is the worst
    // available answer.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("No workspaces yet")).toBeTruthy();
  });

  it("sends a signed-out visitor to the landing page, not the create form", async () => {
    open("/", authApi({ account: null, workspaces: [] }, { workspaces: [], visited: [] }));
    expect(await screen.findByRole("heading", { name: /Make room for/ })).toBeTruthy();
    // Creating needs an account -- ownership is a membership row -- so the form
    // would only fail. The way in is offered instead.
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
    expect(screen.getByRole("link", { name: /Create your account/ })).toBeTruthy();
  });
});

describe("switching", () => {
  it("moves between workspaces from inside one, and hides archived ones", async () => {
    const user = userEvent.setup();
    open(`/w/${idA}`, authApi());
    await user.click(await screen.findByRole("button", { name: /Switch workspace/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Docs rewrite/ })).toBeTruthy();
    // Archived is read-only and belongs on the home page; the switcher is for
    // the places you are actually working.
    expect(within(menu).queryByRole("menuitem", { name: /Old campaign/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /All workspaces/ })).toBeTruthy();
  });
});

describe("workspace lifecycle", () => {
  it("explains the last-owner refusal instead of claiming you lack permission", async () => {
    const user = userEvent.setup();
    const api = {
      ...authApi(),
      // What the server sends when leaving would strand the workspace. The
      // message it carries is never displayed (§13.3), so the code is all the
      // browser has to work with.
      leaveWorkspace: vi.fn().mockRejectedValue(new ApiError("FORBIDDEN")),
    } as unknown as AuthApi;
    open(`/w/${idA}/settings`, api);
    await user.click(await screen.findByRole("button", { name: "Leave workspace" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only owner/i);
    // The generic copy would be both untrue and unactionable here: they have
    // the permission, and what they need is a second owner.
    expect(alert.textContent).not.toMatch(/do not have permission/i);
  });

  it("asks for the workspace's name before it will delete anything", async () => {
    const user = userEvent.setup();
    open(`/w/${idA}/settings`, authApi());
    await user.click(await screen.findByRole("button", { name: "Delete workspace" }));
    const confirm = await screen.findByRole("button", { name: "Delete permanently" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/to confirm/), "Launch room");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("relative time", () => {
  it("reads as a comparison up to a week, then as a date", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(relativeTime(new Date("2026-09-13T11:59:40Z"), now)).toBe("just now");
    expect(relativeTime(new Date("2026-09-13T09:00:00Z"), now)).toMatch(/3 hours ago/);
    expect(relativeTime(new Date("2026-09-11T12:00:00Z"), now)).toMatch(/2 days ago/);
    // Past a week the elapsed time has stopped meaning anything and the date
    // starts to.
    expect(relativeTime(new Date("2026-08-01T12:00:00Z"), now)).toMatch(/Aug/);
    expect(relativeTime("not a date", now)).toBe("");
  });
});

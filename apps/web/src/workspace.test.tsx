import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { OWNER_KEY_HEADER } from "@app/contracts";
import { App } from "./App";
import {
  BrowserSession,
  bindGuestAwareness,
  GUEST_STORAGE_KEY,
} from "./session";
import { contributionLink, WorkspaceApi } from "./workspace-api";
import type { AuthApi } from "./auth-api";
import type { SessionState } from "@app/contracts";
import { workspace as sample } from "./fixtures";

const id = "abcdef01-0000-4000-8000-000000000001";
const otherId = "abcdef01-0000-4000-8000-000000000002";
const ownerKey = "test-only-owner-secret-123456789";
/**
 * `access` is what decides owner controls now, not `isOwner`.
 *
 * The flag used to be ANDed with a legacy owner key in browser storage; an
 * account-owned workspace has no such key, so that condition was never true and
 * an owner saw none of their own controls. It is the server-resolved membership
 * on this read that answers the question, and these fixtures say so.
 */
const workspace = {
  ...sample,
  id,
  name: "Team room",
  purpose: "Build together",
  isOwner: true,
  access: "owner" as const,
};
const asViewer = { ...workspace, isOwner: false, access: "viewer" as const };
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const errorResponse = (code: string, status: number) =>
  response({ error: { code, message: "Server text is not rendered" } }, status);
function fixture(
  path: string,
  transport: typeof fetch,
  session = new BrowserSession(),
  authApi: AuthApi = signedIn(),
) {
  const api = new WorkspaceApi(session, (input, init) => String(input).endsWith('/inbox')
    ? Promise.resolve(response({ items: [] })) : transport(input, init));
  render(
    <MemoryRouter initialEntries={[path]}>
      <App session={session} api={api} authApi={authApi} />
    </MemoryRouter>,
  );
  return { api, session };
}

/** A link holder: no account, so the browser's own display label is theirs. */
function signedOut(): AuthApi {
  return signedIn({ account: null, workspaces: [], preferences: null });
}
beforeEach(() => {
  localStorage.clear();
});

/**
 * A signed-in account, without a network.
 *
 * Screens behind `RequireAccount` need one; supplying it explicitly keeps each
 * test honest about whether it is exercising a signed-in path or a signed-out
 * one, rather than depending on whatever the default happens to be.
 */
function signedIn(overrides: Partial<SessionState> = {}): AuthApi {
  const state: SessionState = {
    account: { id: "acc-1", email: "ada@example.test", displayName: "Ada" },
    workspaces: [],
    preferences: { theme: "system", lastWorkspace: null },
    ...overrides,
  };
  return {
    configured: true,
    current: async () => state,
    signOut: async () => {},
    savePreferences: async () => state.preferences!,
    members: async () => [],
    invitations: async () => [],
    directory: async () => ({ workspaces: state.workspaces, visited: [] }),
    leaveWorkspace: async () => {},
    refresh: async () => {},
  } as unknown as AuthApi;
}

describe("browser identity and document awareness", () => {
  it("keeps a stable contributor ID through renames and reloads, validates names, and treats markup as text", () => {
    const session = new BrowserSession();
    const original = session.getGuest();
    session.rename("  <b>River</b>  ");
    expect(session.getGuest()).toEqual({ ...original, name: "<b>River</b>" });
    expect(new BrowserSession().getGuest()).toEqual(session.getGuest());
    expect(() => session.rename("  ")).toThrow();
    expect(session.getGuest().name).toBe("<b>River</b>");
  });
  it("updates only the open document user awareness and cleans up its subscription", () => {
    const session = new BrowserSession();
    session.saveOwner(id, ownerKey);
    const awareness = { setLocalStateField: vi.fn() };
    const dispose = bindGuestAwareness(awareness, session);
    const original = session.getGuest();
    session.rename("New name");
    expect(awareness.setLocalStateField).toHaveBeenLastCalledWith("user", {
      id: original.contributorId,
      name: "New name",
      color: original.color,
    });
    expect(
      JSON.stringify(awareness.setLocalStateField.mock.calls),
    ).not.toContain(ownerKey);
    dispose();
    session.rename("After close");
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(3);
    expect(awareness.setLocalStateField).toHaveBeenLastCalledWith("user", null);
  });
  it("uses cross-tab name changes without altering the contributor ID", () => {
    const session = new BrowserSession();
    const guest = session.getGuest();
    const disconnect = session.connect();
    localStorage.setItem(
      GUEST_STORAGE_KEY,
      JSON.stringify({ ...guest, name: "Across tabs" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: GUEST_STORAGE_KEY }),
    );
    expect(session.getGuest()).toEqual({ ...guest, name: "Across tabs" });
    disconnect();
  });
  it("recovers corrupt local identity and keeps names usable with blocked storage", () => {
    localStorage.setItem(GUEST_STORAGE_KEY, "{broken");
    expect(new BrowserSession().getGuest().name).toMatch(/^Guest /);
    const session = new BrowserSession(() => {
      throw new Error("blocked");
    });
    session.rename("Temporary name");
    expect(session.getGuest().name).toBe("Temporary name");
    expect(session.isGuestSaved()).toBe(false);
  });
});

describe("workspace API credential boundaries", () => {
  /*
   * These replace the owner-key tests.
   *
   * There is no key any more: ownership is a membership row, so the risks the
   * old tests guarded -- a key leaking into a URL, a key sent to the wrong
   * workspace, a key lost with browser storage -- are gone by construction.
   * What is worth asserting now is the new equivalent: the client holds no
   * credential at all, and authority travels as a cookie the browser attaches
   * and this code cannot read.
   */
  it("mints no credential on creation and puts none in the DOM or share link", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        workspaceId: id,
        ownerKey: null,
        contributionUrl: `https://app.invalid/w/${id}`,
      }),
    );
    const session = new BrowserSession();
    const api = new WorkspaceApi(session, transport);
    const created = await api.create({ name: "Team room" });

    expect(created).toBe(id);
    // Nothing was stored, because there is nothing a browser needs to keep.
    expect(window.localStorage.getItem(`common.owner.v1.${id}`)).toBeNull();
    expect(contributionLink(id)).not.toContain("ownerKey");
  });

  it("never sends an owner-key header, and lets the browser carry the cookie", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...workspace, isOwner: true }));
    const api = new WorkspaceApi(new BrowserSession(), transport);
    await api.read(id);

    const init = transport.mock.calls[0]![1]!;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      OWNER_KEY_HEADER,
    );
    // The session cookie is HttpOnly, so this is the only way it can travel.
    // Same-origin rather than `include`: nothing needs to be sent cross-site.
    expect(init.credentials).toBe("same-origin");
  });

  it("carries no credential when a request goes to another workspace", async () => {
    // The old failure this guarded against -- one workspace's key being
    // attached to another workspace's request -- cannot happen when the client
    // holds no per-workspace secret at all. Asserted so that stays true.
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...workspace, id: otherId, isOwner: false }));
    const api = new WorkspaceApi(new BrowserSession(), transport);
    await api.read(otherId);

    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toContain(otherId);
    expect(JSON.stringify(init)).not.toContain(ownerKey);
  });
});

describe("A02 workspace interactions", () => {
  it("creates once, opens the workspace, and never places the key in the DOM or share link", async () => {
    const user = userEvent.setup();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          workspaceId: id,
          ownerKey,
          contributionUrl: `https://app.example/w/${id}`,
        }),
      )
      .mockImplementation(async () => response(workspace));
    const authApi = signedIn();
    const current = vi.spyOn(authApi, "current");
    // `/new`, because `/` is the account's workspace list now.
    fixture("/new", transport, new BrowserSession(), authApi);
    await user.type(await screen.findByLabelText("Workspace name"), "Team room");
    await user.type(screen.getByLabelText(/Purpose/), "Build together");
    await user.dblClick(
      screen.getByRole("button", { name: "Create workspace" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Team room" }),
    ).toBeTruthy();
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(current).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(ownerKey);
    await user.click(
      screen.getByRole("button", { name: "Share workspace link" }),
    );
    expect(await navigator.clipboard.readText()).toBe(contributionLink(id));
  });
  it("opens a contribution URL directly without asking for a name and denies owner controls", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(asViewer));
    fixture(`/w/${id}/settings`, transport);
    expect(
      await screen.findByRole("heading", { name: "Workspace details" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save workspace settings" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).readOnly,
    ).toBe(true);
    expect(transport.mock.calls[0]![1]!.headers).not.toHaveProperty(
      OWNER_KEY_HEADER,
    );
  });
  it("allows server-confirmed owners to save name and guidance, preserving edits on failure", async () => {
    const user = userEvent.setup();
    const session = new BrowserSession();
    session.saveOwner(id, ownerKey);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(errorResponse("INTERNAL_ERROR", 500))
      .mockResolvedValueOnce(
        response({
          ...workspace,
          name: "New room",
          guidance: "Be kind",
          guidanceVersion: 2,
        }),
      );
    fixture(`/w/${id}/settings`, transport, session);
    await screen.findByRole("button", { name: "Save workspace settings" });
    await user.clear(await screen.findByLabelText("Workspace name"));
    await user.type(await screen.findByLabelText("Workspace name"), "New room");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Be kind");
    await user.click(
      screen.getByRole("button", { name: "Save workspace settings" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Be kind");
    await user.click(
      screen.getByRole("button", { name: "Save workspace settings" }),
    );
    expect(await screen.findByText("Workspace settings saved.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "New room",
    );
    expect(transport.mock.calls[2]![1]!.body).toBe(
      JSON.stringify({
        name: "New room",
        purpose: "Be kind",
        guidance: "Be kind",
      }),
    );
  });
  it("lets an account owner edit settings without a legacy browser key", async () => {
    const session = new BrowserSession();
    fixture(`/w/${id}/settings`, vi.fn<typeof fetch>().mockResolvedValue(response(workspace)), session);
    expect(await screen.findByRole("button", { name: "Save workspace settings" })).toBeTruthy();
    expect(session.getOwnerKey(id)).toBeUndefined();
  });
  // The server is the authority on who may administer a workspace. Whichever
  // way it says no -- a role changed in another tab, a session that expired --
  // the controls go and the typing stays, because losing somebody's words is a
  // worse outcome than a button that has stopped working.
  it.each(["OWNER_KEY_REQUIRED", "AUTH_REQUIRED", "FORBIDDEN"])("removes owner controls after %s, keeping unsaved text visible", async (code) => {
    const session = new BrowserSession();
    const user = userEvent.setup();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(errorResponse(code, 403));
    fixture(`/w/${id}/settings`, transport, session);
    await user.click(
      await screen.findByRole("button", { name: "Save workspace settings" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save workspace settings" }),
    ).toBeNull();
    expect(screen.getByLabelText("Description")).toBeTruthy();
  });
  it("keeps owner controls when browser storage is cleared", async () => {
    /*
     * The regression this replaces a test for.
     *
     * Clearing storage used to take host controls away, because the owner key
     * lived there and was ANDed into `isOwner`. Ownership is a membership row
     * now: the same person on a new device, or after clearing site data, is
     * still the owner, and the request carries no per-browser secret at all.
     *
     * The other direction -- the server saying this caller may not administer
     * the workspace -- is covered by the FORBIDDEN test above and by the
     * viewer fixture, both of which drive it from the server's answer.
     */
    const session = new BrowserSession();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response(workspace));
    fixture(`/w/${id}/settings`, transport, session);
    await screen.findByRole("button", { name: "Save workspace settings" });
    localStorage.clear();
    fireEvent(window, new StorageEvent("storage", { key: null }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save workspace settings" }),
      ).toBeTruthy(),
    );
    expect(transport.mock.calls.at(-1)![1]!.headers).not.toHaveProperty(
      OWNER_KEY_HEADER,
    );
  });
  it("updates a link holder's display name as plain text, without changing browser identity", async () => {
    // Signed out, the browser's own label is what other people see, so it is
    // editable here. Signed in it is the account's name and this control is
    // not drawn -- renaming yourself is the identity provider's business.
    const user = userEvent.setup();
    const session = new BrowserSession();
    const originalId = session.getGuest().contributorId;
    fixture(
      `/w/${id}`,
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(asViewer)),
      session,
      signedOut(),
    );
    await user.click(
      await screen.findByRole("button", { name: /Edit display name/ }),
    );
    await user.clear(screen.getByLabelText("Your display name"));
    await user.type(screen.getByLabelText("Your display name"), "  ");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.clear(screen.getByLabelText("Your display name"));
    await user.type(screen.getByLabelText("Your display name"), "<b>River</b>");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByRole("button", {
        name: "Edit display name: <b>River</b>",
      }),
    ).toBeTruthy();
    expect(session.getGuest().contributorId).toBe(originalId);
    expect(document.querySelector(".guest-control b")).toBeNull();
  });
  it("shows actionable rate-limit and missing-workspace errors", async () => {
    const user = userEvent.setup();
    fixture(
      "/new",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(errorResponse("RATE_LIMITED", 429)),
    );
    await user.type(await screen.findByLabelText("Workspace name"), "New room");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Wait a moment",
    );
    expect(
      (await screen.findByLabelText("Workspace name") as HTMLInputElement).value,
    ).toBe("New room");
  });
  it("shows a missing-workspace response without rendering the sample workspace", async () => {
    fixture(
      `/w/${id}`,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(errorResponse("WORKSPACE_NOT_FOUND", 404)),
    );
    expect(
      await screen.findByRole("heading", { name: "Workspace not found" }),
    ).toBeTruthy();
    expect(screen.queryByText("Launch room")).toBeNull();
  });
});

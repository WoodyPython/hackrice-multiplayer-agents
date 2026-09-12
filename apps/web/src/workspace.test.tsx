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
import { workspace as sample } from "./fixtures";

const id = "abcdef01-0000-4000-8000-000000000001";
const otherId = "abcdef01-0000-4000-8000-000000000002";
const ownerKey = "test-only-owner-secret-123456789";
const workspace = {
  ...sample,
  id,
  name: "Team room",
  purpose: "Build together",
  isOwner: true,
};
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
) {
  const api = new WorkspaceApi(session, transport);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App session={session} api={api} />
    </MemoryRouter>,
  );
  return { api, session };
}
beforeEach(() => {
  localStorage.clear();
});

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

describe("workspace API key boundaries", () => {
  it("stores the one-time creation key and sends it only in the matching workspace header", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          workspaceId: id,
          ownerKey,
          contributionUrl: `https://untrusted.invalid/w/${id}?ownerKey=${ownerKey}`,
        }),
      )
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(
        response({ ...workspace, id: otherId, isOwner: false }),
      )
      .mockResolvedValueOnce(response(workspace));
    const session = new BrowserSession();
    const api = new WorkspaceApi(session, transport);
    expect(await api.create({ name: "Team room" })).toBe(id);
    expect(new BrowserSession().getOwnerKey(id)).toBe(ownerKey);
    await api.read(id);
    await api.read(otherId);
    await api.update(id, { guidance: "Clear writing" });
    expect(transport.mock.calls[0]![1]!.headers).not.toHaveProperty(
      OWNER_KEY_HEADER,
    );
    expect(transport.mock.calls[1]![1]!.headers).toHaveProperty(
      OWNER_KEY_HEADER,
      ownerKey,
    );
    expect(transport.mock.calls[2]![1]!.headers).not.toHaveProperty(
      OWNER_KEY_HEADER,
    );
    expect(transport.mock.calls[3]![1]!.headers).toHaveProperty(
      OWNER_KEY_HEADER,
      ownerKey,
    );
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).not.toContain(ownerKey);
      expect(init?.body ?? "").not.toContain(ownerKey);
      expect(init?.redirect).toBe("error");
    }
    expect(contributionLink(id, "https://app.example/")).toBe(
      `https://app.example/w/${id}`,
    );
  });
  it("blocks creation before requesting when owner storage is unavailable", async () => {
    const transport = vi.fn<typeof fetch>();
    const api = new WorkspaceApi(
      new BrowserSession(() => {
        throw new Error("blocked");
      }),
      transport,
    );
    await expect(api.create({ name: "Room" })).rejects.toThrow(
      "BROWSER_STORAGE_UNAVAILABLE",
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("retains a creation key in memory if storage fails after creation, then retries saving", async () => {
    const session = new BrowserSession();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      write.mockImplementation(() => {
        throw new Error("full");
      });
      return response({
        workspaceId: id,
        ownerKey,
        contributionUrl: `https://app.example/w/${id}`,
      });
    });
    const api = new WorkspaceApi(session, transport);
    await api.create({ name: "Room" });
    expect(session.hasUnsavedOwner(id)).toBe(true);
    expect(session.getOwnerKey(id)).toBe(ownerKey);
    write.mockRestore();
    expect(session.retryOwnerSave(id)).toBe(true);
    expect(new BrowserSession().getOwnerKey(id)).toBe(ownerKey);
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
    fixture("/", transport);
    await user.type(screen.getByLabelText("Workspace name"), "Team room");
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
    expect(document.body.textContent).not.toContain(ownerKey);
    await user.click(
      screen.getByRole("button", { name: "Copy workspace link" }),
    );
    expect(await navigator.clipboard.readText()).toBe(contributionLink(id));
  });
  it("opens a contribution URL directly without asking for a name and denies owner controls", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...workspace, isOwner: false }));
    fixture(`/w/${id}/settings`, transport);
    expect(
      await screen.findByRole("heading", { name: "Workspace guidance" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save workspace settings" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Guidance") as HTMLTextAreaElement).readOnly,
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
    await user.clear(screen.getByLabelText("Workspace name"));
    await user.type(screen.getByLabelText("Workspace name"), "New room");
    await user.clear(screen.getByLabelText("Guidance"));
    await user.type(screen.getByLabelText("Guidance"), "Be kind");
    await user.click(
      screen.getByRole("button", { name: "Save workspace settings" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      (screen.getByLabelText("Guidance") as HTMLTextAreaElement).value,
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
        purpose: workspace.purpose,
        guidance: "Be kind",
      }),
    );
  });
  it("removes owner controls when the server rejects a key, keeping unsaved text visible", async () => {
    const user = userEvent.setup();
    const session = new BrowserSession();
    session.saveOwner(id, ownerKey);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(errorResponse("OWNER_KEY_REQUIRED", 403));
    fixture(`/w/${id}/settings`, transport, session);
    await user.click(
      await screen.findByRole("button", { name: "Save workspace settings" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save workspace settings" }),
    ).toBeNull();
    expect(screen.getByLabelText("Guidance")).toBeTruthy();
  });
  it("rechecks ownership after browser storage is cleared", async () => {
    const session = new BrowserSession();
    session.saveOwner(id, ownerKey);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValue(response({ ...workspace, isOwner: false }));
    fixture(`/w/${id}/settings`, transport, session);
    await screen.findByRole("button", { name: "Save workspace settings" });
    localStorage.clear();
    fireEvent(window, new StorageEvent("storage", { key: null }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save workspace settings" }),
      ).toBeNull(),
    );
    expect(transport.mock.calls.at(-1)![1]!.headers).not.toHaveProperty(
      OWNER_KEY_HEADER,
    );
  });
  it("updates the header name as plain text without changing browser identity", async () => {
    const user = userEvent.setup();
    const session = new BrowserSession();
    const originalId = session.getGuest().contributorId;
    fixture(
      `/w/${id}`,
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          response({ ...workspace, isOwner: false }),
        ),
      session,
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
      "/",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(errorResponse("RATE_LIMITED", 429)),
    );
    await user.type(screen.getByLabelText("Workspace name"), "New room");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Wait a moment",
    );
    expect(
      (screen.getByLabelText("Workspace name") as HTMLInputElement).value,
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

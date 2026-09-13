import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { AuthProvider } from "./auth-context";
import { stubAuthApi } from "./test-auth";
import { AcceptInvite } from "./pages/AcceptInvite";

const preview = { workspaceName: "Team Alpha", role: "member" as const, emailMismatch: false };
const membership = { workspaceId: "00000000-0000-4000-8000-000000000001", name: "Team Alpha", role: "member" as const, joinedAt: new Date().toISOString() };

function NextInvitation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/invite/second")}>Another invitation</button>;
}

function SignInDestination() {
  const [params] = useSearchParams();
  return <h1>Sign in, then return to {params.get("next")}</h1>;
}

function mount(api: ReturnType<typeof stubAuthApi>) {
  render(<MemoryRouter initialEntries={["/invite/first"]}>
    <AuthProvider api={api}><NextInvitation /><Routes>
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/w/:id" element={<h1>Workspace opened</h1>} />
      <Route path="/signin" element={<SignInDestination />} />
    </Routes></AuthProvider>
  </MemoryRouter>);
}

describe("invitation recovery", () => {
  it("lets the wrong account sign out without losing the invitation destination", async () => {
    const api = stubAuthApi();
    api.previewInvitation = vi.fn().mockResolvedValue({ ...preview, emailMismatch: true });
    api.signOut = vi.fn().mockResolvedValue(undefined);
    mount(api);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in, then return to /invite/first" });
    expect(api.signOut).toHaveBeenCalledTimes(1);
  });

  it("lets a transient preview failure be retried", async () => {
    const api = stubAuthApi();
    api.previewInvitation = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(preview);
    mount(api);
    await screen.findByText("Could not read this invitation.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Join Team Alpha" });
  });

  it("clears an old invitation failure when following a different link", async () => {
    const api = stubAuthApi();
    api.previewInvitation = vi.fn(async (token) => {
      if (token === "first") throw new Error("offline");
      return preview;
    });
    mount(api);
    await screen.findByText("Could not read this invitation.");
    await userEvent.click(screen.getByRole("button", { name: "Another invitation" }));
    await screen.findByRole("heading", { name: "Join Team Alpha" });
    expect(screen.queryByText("Could not read this invitation.")).toBeNull();
  });

  it("keeps the join action available after a temporary acceptance failure", async () => {
    const api = stubAuthApi();
    api.previewInvitation = vi.fn().mockResolvedValue(preview);
    api.acceptInvitation = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(membership);
    mount(api);
    await userEvent.click(await screen.findByRole("button", { name: "Join as Ada" }));
    await screen.findByText("Could not accept the invitation. Try again.");
    await userEvent.click(screen.getByRole("button", { name: "Join as Ada" }));
    await screen.findByRole("heading", { name: "Workspace opened" });
    expect(api.acceptInvitation).toHaveBeenCalledTimes(2);
  });

  it("opens an accepted workspace even if the subsequent session refresh fails", async () => {
    const api = stubAuthApi();
    const initial = await api.current();
    api.current = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(new Error("offline"));
    api.previewInvitation = vi.fn().mockResolvedValue(preview);
    api.acceptInvitation = vi.fn().mockResolvedValue(membership);
    mount(api);
    await userEvent.click(await screen.findByRole("button", { name: "Join as Ada" }));
    await screen.findByRole("heading", { name: "Workspace opened" });
    await waitFor(() => expect(api.acceptInvitation).toHaveBeenCalledTimes(1));
  });
});

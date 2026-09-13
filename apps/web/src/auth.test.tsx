import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionState } from "@app/contracts";
import { AuthApi } from "./auth-api";
import { AuthProvider, useAuth } from "./auth-context";
import { stubAuthApi } from "./test-auth";
import { SignIn } from "./pages/SignIn";
import { AccountControl } from "./components/AccountControl";

const signedOut: SessionState = { account: null, workspaces: [], preferences: null };
const signedIn: SessionState = {
  account: { id: "00000000-0000-4000-8000-000000000001", email: "ada@example.test", displayName: "Ada" },
  workspaces: [], preferences: { theme: "system", lastWorkspace: null },
};
let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <div>{auth.loading ? "Loading" : auth.account?.displayName ?? "Signed out"}</div>;
}
afterEach(() => vi.unstubAllGlobals());

describe("authentication session lifecycle", () => {
  it("loads the default client once instead of fetching on every render", async () => {
    const transport = vi.fn(async () => Response.json(signedOut));
    vi.stubGlobal("fetch", transport);
    const view = render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Signed out");
    view.rerender(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => {});
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a completed sign-in with a stale startup response", async () => {
    let resolve!: (state: SessionState) => void;
    const api = stubAuthApi();
    api.current = () => new Promise((done) => { resolve = done; });
    render(<AuthProvider api={api}><Probe /></AuthProvider>);
    act(() => auth.setSession(signedIn));
    await act(async () => resolve(signedOut));
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("does not restore a logged-out account from an older refresh", async () => {
    const api = stubAuthApi(signedIn);
    render(<AuthProvider api={api}><Probe /></AuthProvider>);
    await screen.findByText("Ada");
    let resolve!: (state: SessionState) => void;
    api.current = () => new Promise((done) => { resolve = done; });
    let refreshing!: Promise<void>;
    act(() => { refreshing = auth.refresh(); });
    await act(async () => auth.signOut());
    await act(async () => { resolve(signedIn); await refreshing; });
    expect(screen.getByText("Signed out")).toBeTruthy();
  });

  it("preserves the current account when refreshing fails", async () => {
    const api = stubAuthApi(signedIn);
    render(<AuthProvider api={api}><Probe /></AuthProvider>);
    await screen.findByText("Ada");
    api.current = async () => { throw new Error("temporary outage"); };
    await act(async () => { await expect(auth.refresh()).rejects.toThrow("temporary outage"); });
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("uses the successful exchange without an extra session request and accepts existing short passwords", async () => {
    const api = stubAuthApi(signedOut);
    api.current = vi.fn(async () => signedOut);
    api.signIn = vi.fn(async () => signedIn);
    render(<MemoryRouter initialEntries={["/signin?next=/welcome"]}>
      <AuthProvider api={api}><Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/welcome" element={<Probe />} />
      </Routes></AuthProvider>
    </MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Ada");
    expect(api.signIn).toHaveBeenCalledWith("ada@example.test", "short");
    expect(api.current).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed sign-out visible as a failure", async () => {
    const api = new AuthApi(null, async () => Response.json({}, { status: 503 }));
    await expect(api.signOut()).rejects.toThrow("Could not sign out");
    await expect(api.current()).rejects.toThrow("Could not check your session");
  });

  it("recognizes an expired session", async () => {
    const api = new AuthApi(null, async () => Response.json({}, { status: 401 }));
    await expect(api.current()).resolves.toEqual(signedOut);
  });

  it("offers retry after failed logout and only redirects once logout succeeds", async () => {
    const api = stubAuthApi(signedIn);
    api.signOut = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(<MemoryRouter><AuthProvider api={api}><Routes>
      <Route path="/" element={<><Probe /><AccountControl /></>} />
      <Route path="/signin" element={<div>Sign-in screen</div>} />
    </Routes></AuthProvider></MemoryRouter>);
    const user = userEvent.setup();
    await screen.findByText("Ada");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not sign out. Try again.");
    expect(screen.getByText("Ada")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign-in screen");
    expect(api.signOut).toHaveBeenCalledTimes(2);
  });
});

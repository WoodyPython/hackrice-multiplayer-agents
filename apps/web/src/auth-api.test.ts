import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@app/contracts";
import { AuthApi } from "./auth-api";

const config = { url: "https://auth.example.test", publishableKey: "public-test-key" };
const session: SessionState = {
  account: { id: "00000000-0000-4000-8000-000000000001", email: "ada@example.test", displayName: "Ada" },
  workspaces: [], preferences: { theme: "system", lastWorkspace: null },
};
afterEach(() => vi.restoreAllMocks());

describe("authentication transport", () => {
  it("sends a password only to the provider and exchanges its token for the application session", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-provider-token" }))
      .mockResolvedValueOnce(Response.json(session));
    const api = new AuthApi(config, transport);
    await expect(api.signIn(" Ada ", "test-password")).resolves.toEqual(session);
    expect(transport).toHaveBeenCalledTimes(2);
    const [providerUrl, providerInit] = transport.mock.calls[0]!;
    expect(providerUrl).toBe("https://auth.example.test/auth/v1/token?grant_type=password");
    expect(providerInit).toMatchObject({ method: "POST", credentials: "omit", headers: { apikey: "public-test-key" } });
    expect(JSON.parse(providerInit!.body as string)).toEqual({ email: "ada@accounts.coflow.local", password: "test-password" });
    const [exchangeUrl, exchangeInit] = transport.mock.calls[1]!;
    expect(exchangeUrl).toBe("/api/auth/session");
    expect(exchangeInit).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(exchangeInit!.body as string)).toEqual({ accessToken: "test-provider-token" });
  });

  it("creates a confirmed username account through the application server", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(session, { status: 201 }));
    const api = new AuthApi(config, transport);
    await expect(api.signUp(" Ada ", "test-password")).resolves.toEqual(session);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("/api/auth/signup");
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({
      username: "ada", password: "test-password",
    });
  });

  it("surfaces a username conflict from signup", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: { code: "CONFLICT", message: "That username is already taken." },
    }, { status: 409 }));
    await expect(new AuthApi(config, transport).signUp("ada", "test-password"))
      .rejects.toThrow("That username is already taken.");
  });

  it("turns provider rejection into a username-safe message and never exchanges a token", async () => {
    const body = { error_description: "Invalid login credentials" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 400 }));
    await expect(new AuthApi(config, transport).signIn("ada", "test-password"))
      .rejects.toThrow("Incorrect username or password.");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not report login success when the session exchange fails", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-provider-token" }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(new AuthApi(config, transport).signIn("ada", "test-password"))
      .rejects.toThrow("Could not start a session");
  });

  it.each(["provider", "exchange", "logout"] as const)("aborts a stalled %s request", async (stage) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      if (stage === "exchange" && transport.mock.calls.length === 1) {
        return Response.json({ access_token: "test-provider-token" });
      }
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        started();
      });
    });
    const api = new AuthApi(config, transport);
    const pending = stage === "logout" ? api.signOut() : api.signIn("ada", "test-password");
    const rejected = expect(pending).rejects.toThrow("Timed out");
    await requestStarted;
    controller.abort(new Error("Timed out"));
    await rejected;
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});

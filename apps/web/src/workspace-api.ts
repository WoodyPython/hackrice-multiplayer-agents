import {
  ApiError,
  OWNER_KEY_HEADER,
  apiErrorBodySchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  updateWorkspaceRequestSchema,
  uuidSchema,
  workspaceSchema,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type Workspace,
} from "@app/contracts";
import { BrowserSession } from "./session";

export class WorkspaceApi {
  constructor(
    private session: BrowserSession,
    private transport: typeof fetch = (...args) => fetch(...args),
  ) {}
  private async request(
    path: string,
    method: string,
    body?: unknown,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const key = workspaceId ? this.session.getOwnerKey(workspaceId) : undefined;
    if (key) headers[OWNER_KEY_HEADER] = key;
    const response = await this.transport(`/api/workspaces${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = apiErrorBodySchema.safeParse(data);
      // Never display/retain arbitrary server messages or request headers.
      throw new ApiError(
        error.success ? error.data.error.code : "INTERNAL_ERROR",
      );
    }
    return data;
  }
  async create(input: CreateWorkspaceRequest): Promise<string> {
    if (!this.session.canPersist())
      throw new Error("BROWSER_STORAGE_UNAVAILABLE");
    const body = createWorkspaceRequestSchema.parse(input);
    const result = createWorkspaceResponseSchema.parse(
      await this.request("", "POST", body),
    );
    this.session.saveOwner(result.workspaceId, result.ownerKey);
    return result.workspaceId;
  }
  async read(id: string, signal?: AbortSignal): Promise<Workspace> {
    uuidSchema.parse(id);
    return workspaceSchema.parse(
      await this.request(`/${id}`, "GET", undefined, id, signal),
    );
  }
  async update(id: string, input: UpdateWorkspaceRequest): Promise<Workspace> {
    uuidSchema.parse(id);
    if (!this.session.getOwnerKey(id)) throw new ApiError("OWNER_KEY_REQUIRED");
    return workspaceSchema.parse(
      await this.request(
        `/${id}`,
        "PATCH",
        updateWorkspaceRequestSchema.parse(input),
        id,
      ),
    );
  }
}

export function workspaceError(error: unknown): string {
  if (error instanceof Error && error.message === "BROWSER_STORAGE_UNAVAILABLE")
    return "Enable browser storage before creating a workspace so this browser can retain owner access.";
  if (error instanceof ApiError) {
    switch (error.code) {
      case "RATE_LIMITED":
        return "Too many workspaces were created recently. Wait a moment before trying again.";
      case "OWNER_KEY_REQUIRED":
        return "Owner access is unavailable in this browser. You can still contribute through the workspace link.";
      case "WORKSPACE_NOT_FOUND":
        return "This workspace could not be found. Check the contribution link.";
      case "VALIDATION_FAILED":
        return "Check the name, purpose, and guidance limits before saving.";
    }
  }
  return "We could not confirm the request. Your entered text is still here. Check your connection before trying again.";
}

/** Construct from a validated ID; discard query strings, fragments, and server-supplied URLs. */
export function contributionLink(
  id: string,
  origin = window.location.origin,
): string {
  return new URL(`/w/${uuidSchema.parse(id)}`, origin).href;
}

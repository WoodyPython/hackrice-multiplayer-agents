import {
  ApiError,
  OWNER_KEY_HEADER,
  answerQuestionResponseSchema,
  apiErrorBodySchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  discussionEntrySchema,
  draftCaptureSchema,
  draftFileSchema,
  isSupportedTextExtension,
  listDiscussionResponseSchema,
  applyReviewResponseSchema,
  listTaskAgentsResponseSchema,
  listHistoryResponseSchema,
  listSavedOutputsResponseSchema,
  listTaskReviewsResponseSchema,
  materialSchema,
  reviewDetailSchema,
  taskEventSchema,
  openDraftResponseSchema,
  postTaskRequestSchema,
  startTaskResponseSchema,
  taskDetailSchema,
  taskSummarySchema,
  updateTaskRequestSchema,
  updateWorkspaceRequestSchema,
  uuidSchema,
  workspaceSchema,
  MAX_TEXT_FILE_BYTES,
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  type CreateWorkspaceRequest,
  type DiscussionEntry,
  type DraftCapture,
  type DraftFile,
  type HistoryEntry,
  type SavedOutputOption,
  type ListDiscussionResponse,
  type Material,
  type ApplyReviewResponse,
  type ResolveCandidateRequest,
  type Review,
  type ReviewDetail,
  type TaskAttempt,
  type TaskEvent,
  type OpenDraftResponse,
  type PostDiscussionRequest,
  type PostTaskRequest,
  type StartTaskResponse,
  type TaskDetail,
  type TaskSummary,
  type UpdateTaskRequest,
  type UpdateWorkspaceRequest,
  type Workspace,
} from "@app/contracts";
import { z } from "zod";
import { BrowserSession } from "./session";

/**
 * The one place the browser talks to the API.
 *
 * Two rules hold across every method and both come from the interface notes in
 * `docs/interfaces/role-a.md`:
 *
 * Responses are parsed with the contract schema rather than cast. A cast turns
 * a backend shape change into a render-time crash somewhere far away; a parse
 * turns it into one failed request at the boundary.
 *
 * Server-supplied text is never surfaced. `request` keeps the error *code* and
 * discards the message, and `apiMessage` maps codes to copy this file owns.
 * Design §13.3: an uploaded file can carry markup, and an echoed request can
 * carry a header.
 */
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
    return this.send(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  /** Shared tail of every call: fixed fetch options, one error shape. */
  private async send(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.transport(`/api/workspaces${path}`, {
      ...init,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorBodySchema.safeParse(data);
      // Never display/retain arbitrary server messages or request headers.
      // `details` is structured and ours to read; `message` is not.
      throw new ApiError(
        parsed.success ? parsed.data.error.code : "INTERNAL_ERROR",
        undefined,
        parsed.success ? parsed.data.error.details : undefined,
      );
    }
    return data;
  }

  // --- workspace -----------------------------------------------------------

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

  // --- tasks ---------------------------------------------------------------

  async listTasks(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TaskSummary[]> {
    uuidSchema.parse(workspaceId);
    const data = await this.request(
      `/${workspaceId}/tasks`,
      "GET",
      undefined,
      workspaceId,
      signal,
    );
    return z
      .object({ tasks: z.array(taskSummarySchema) })
      .parse(data).tasks;
  }

  async readTask(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskDetail> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return taskDetailSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    );
  }

  async postTask(
    workspaceId: string,
    input: PostTaskRequest,
  ): Promise<TaskDetail> {
    uuidSchema.parse(workspaceId);
    return taskDetailSchema.parse(
      await this.request(
        `/${workspaceId}/tasks`,
        "POST",
        postTaskRequestSchema.parse(input),
        workspaceId,
      ),
    );
  }

  /**
   * Revise requirements. §2.1: optimistic version check, so two form saves
   * cannot silently overwrite each other. A 409 here is normal — the caller
   * refetches and re-applies rather than treating it as a failure.
   */
  async updateTask(
    workspaceId: string,
    taskId: string,
    input: UpdateTaskRequest,
  ): Promise<TaskDetail> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return taskDetailSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}`,
        "PATCH",
        updateTaskRequestSchema.parse(input),
        workspaceId,
      ),
    );
  }

  /**
   * §2.2. `clientRequestId` is required, not optional: it is what makes a
   * replayed request resolve to the original run instead of creating a second.
   */
  async startTask(
    workspaceId: string,
    taskId: string,
    input: { expectedVersion: number; clientRequestId: string },
  ): Promise<StartTaskResponse> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return startTaskResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/start`,
        "POST",
        input,
        workspaceId,
      ),
    );
  }

  async cancelTask(
    workspaceId: string,
    taskId: string,
    clientRequestId: string,
  ): Promise<void> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    await this.request(
      `/${workspaceId}/tasks/${taskId}/cancel`,
      "POST",
      { clientRequestId },
      workspaceId,
    );
  }

  /**
   * Work a previous attempt completed before it failed (§4.7, C08).
   *
   * The point of listing these is that a retry does not have to redo work that
   * already succeeded — §2.4's `incomplete` state exists so saved work stays
   * inspectable and reusable rather than being thrown away with the attempt.
   */
  async listSavedOutputs(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<SavedOutputOption[]> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return listSavedOutputsResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/saved-outputs`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    ).outputs;
  }

  /**
   * Retry as an explicit new attempt (§2.4, C08).
   *
   * `savedOutputs` carries selection *identities*, never the commit SHA the
   * listing returned — the server resolves the SHA under the task lock, so a
   * client cannot name a commit of its own choosing. A replay preserves the
   * original selection.
   */
  async retryTask(
    workspaceId: string,
    taskId: string,
    input: {
      expectedVersion?: number;
      clientRequestId: string;
      savedOutputs?: Array<{ agentInstanceId: string; path: string }>;
    },
  ): Promise<StartTaskResponse> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return startTaskResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/retry`,
        "POST",
        { ...input, savedOutputs: input.savedOutputs ?? [] },
        workspaceId,
      ),
    );
  }

  /**
   * Assignments for every attempt on a task (§4.5).
   *
   * Task-scoped rather than run-scoped because `TaskDetail.activeRunId` goes
   * null the moment a run ends, and the assignments of a finished attempt are
   * exactly what someone inspecting an `incomplete` task needs to look at.
   */
  async listTaskAgents(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskAttempt[]> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return listTaskAgentsResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/agents`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    ).attempts;
  }

  /**
   * Durable task events (§11.5) — the authoritative progress record.
   *
   * A refresh hint is only a prompt to come here, so this has to be correct
   * with no hint ever arriving. Cursor-paginated by `id`, which makes a refetch
   * additive and therefore safe to trigger as often as anything asks.
   */
  async listTaskEvents(
    workspaceId: string,
    taskId: string,
    afterId?: string,
    signal?: AbortSignal,
  ): Promise<{ events: TaskEvent[]; latestId: string | null }> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    const query = afterId ? `?afterId=${encodeURIComponent(afterId)}` : "";
    return z
      .object({
        events: z.array(taskEventSchema),
        latestId: z.string().nullable(),
      })
      .parse(
        await this.request(
          `/${workspaceId}/tasks/${taskId}/events${query}`,
          "GET",
          undefined,
          workspaceId,
          signal,
        ),
      );
  }

  /**
   * Capture the task's live drafts into a Git checkpoint (§7.4, D04).
   *
   * Captures **every** active document in the task, not one file, so it belongs
   * to the task rather than to whichever document is open.
   *
   * "Saved" has to be true first. Capture takes the text the server has
   * acknowledged, so checkpointing with unsent edits in the buffer would commit
   * a version the author never saw — §4.4 is precise that Saved means persisted
   * to Supabase, and this is the thing that depends on it.
   */
  async checkpointDrafts(
    workspaceId: string,
    taskId: string,
  ): Promise<DraftCapture> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return draftCaptureSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/checkpoint`,
        "POST",
        {},
        workspaceId,
      ),
    );
  }

  /**
   * Applied changes across the workspace, newest first (§4.1).
   *
   * Built on apply operations, so it includes outcomes that were not applied:
   * a `failed` or `ambiguous` operation is part of what happened here, and
   * hiding it would make a stuck apply invisible in the screen meant to explain
   * the workspace's past.
   */
  async listHistory(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry[]> {
    uuidSchema.parse(workspaceId);
    return listHistoryResponseSchema.parse(
      await this.request(
        `/${workspaceId}/history`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    ).entries;
  }

  // --- reviews -------------------------------------------------------------

  /**
   * Reviews on a task, newest first — metadata only (§4.6).
   *
   * This is the read path that lets a screen find out what it is looking at.
   * `POST /tasks/:t/review` builds a Git candidate and refuses from a dozen
   * states, so it cannot be called on load just to discover an ID.
   */
  async listTaskReviews(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<Review[]> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return listTaskReviewsResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/reviews`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    ).reviews;
  }

  /**
   * The candidate behind one review: changed files, diffs, conflicts.
   *
   * Reads the Git artifact, so it fails with `INVALID_STATE` for a review that
   * is still `building` and has no candidate SHA. Callers check status first.
   */
  async readReview(
    workspaceId: string,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<ReviewDetail> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(reviewId);
    return reviewDetailSchema.parse(
      await this.request(
        `/${workspaceId}/reviews/${reviewId}`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    );
  }

  /**
   * Build a review candidate for this task (§2.5, "request review").
   *
   * A real mutation with real preconditions — it refuses while a run is active,
   * before assignments have all completed, and when a selected material has
   * gone missing. Only ever called from an explicit user action.
   */
  async prepareReview(
    workspaceId: string,
    taskId: string,
  ): Promise<ReviewDetail> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return reviewDetailSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/review`,
        "POST",
        {},
        workspaceId,
      ),
    );
  }

  /**
   * Resolve conflicting paths. §10.2: this creates a NEW candidate rather than
   * editing the approved one in place, so `candidateSha` changes and anything
   * holding the old one is now stale.
   */
  async resolveReview(
    workspaceId: string,
    reviewId: string,
    input: ResolveCandidateRequest,
  ): Promise<ReviewDetail> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(reviewId);
    return reviewDetailSchema.parse(
      await this.request(
        `/${workspaceId}/reviews/${reviewId}/resolve`,
        "POST",
        input,
        workspaceId,
      ),
    );
  }

  /**
   * Owner apply (§10.3). The owner key travels in the header, added by
   * `request` — never in the body, and an `isOwner` flag in one would be
   * ignored. `candidateSha` must equal the review's current candidate, so a
   * browser looking at a superseded one is refused rather than applying it.
   */
  async applyReview(
    workspaceId: string,
    reviewId: string,
    candidateSha: string,
    clientRequestId: string,
  ): Promise<ApplyReviewResponse> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(reviewId);
    return applyReviewResponseSchema.parse(
      await this.request(
        `/${workspaceId}/reviews/${reviewId}/apply`,
        "POST",
        { candidateSha, clientRequestId },
        workspaceId,
      ),
    );
  }

  // --- discussion ----------------------------------------------------------

  /**
   * Cursor-paginated by `seq`, never by timestamp. Passing the highest seq the
   * caller already holds makes a refetch additive, which is what lets a refresh
   * hint be fired as often as it likes without redisplaying the thread.
   */
  async listDiscussion(
    workspaceId: string,
    taskId: string,
    afterSeq = 0,
    signal?: AbortSignal,
  ): Promise<ListDiscussionResponse> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return listDiscussionResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/discussion?afterSeq=${afterSeq}`,
        "GET",
        undefined,
        workspaceId,
        signal,
      ),
    );
  }

  async postDiscussion(
    workspaceId: string,
    taskId: string,
    input: PostDiscussionRequest,
  ): Promise<DiscussionEntry> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return discussionEntrySchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/discussion`,
        "POST",
        input,
        workspaceId,
      ),
    );
  }

  /**
   * §2.6. An answer is not an ordinary comment: it is routed to the waiting
   * agent through its question record, which is why it reaches a run whose
   * discussion cutoff it sits above.
   */
  async answerQuestion(
    workspaceId: string,
    taskId: string,
    input: AnswerQuestionRequest,
  ): Promise<AnswerQuestionResponse> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    return answerQuestionResponseSchema.parse(
      await this.request(
        `/${workspaceId}/tasks/${taskId}/answer`,
        "POST",
        input,
        workspaceId,
      ),
    );
  }

  // --- materials -----------------------------------------------------------

  async listMaterials(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Material[]> {
    uuidSchema.parse(workspaceId);
    const data = await this.request(
      `/${workspaceId}/materials`,
      "GET",
      undefined,
      workspaceId,
      signal,
    );
    return z.object({ materials: z.array(materialSchema) }).parse(data)
      .materials;
  }

  async listTaskMaterials(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<Material[]> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    const data = await this.request(
      `/${workspaceId}/tasks/${taskId}/materials`,
      "GET",
      undefined,
      workspaceId,
      signal,
    );
    return z.object({ materials: z.array(materialSchema) }).parse(data)
      .materials;
  }

  /**
   * Upload is multipart, so it bypasses `request` and its JSON content type.
   *
   * The extension and size are checked here as well as on the server. That is
   * not redundant politeness: §3.4 rejects binary, and finding out by dragging
   * in a PDF and reading a validation error is a worse experience than being
   * told which files are accepted before the request leaves.
   *
   * `reused` reflects the 200/201 split — identical bytes return the existing
   * material, and the caller must not render a second card for it.
   */
  async uploadMaterial(
    workspaceId: string,
    file: File,
    guestLabel: string,
    link?: { taskId?: string; discussionEntryId?: string },
  ): Promise<{ material: Material; reused: boolean }> {
    uuidSchema.parse(workspaceId);
    if (!isSupportedTextExtension(file.name))
      throw new ApiError("VALIDATION_FAILED");
    if (file.size > MAX_TEXT_FILE_BYTES) throw new ApiError("VALIDATION_FAILED");
    const form = new FormData();
    form.append("guestLabel", guestLabel);
    if (link?.taskId) form.append("taskId", link.taskId);
    if (link?.discussionEntryId)
      form.append("discussionEntryId", link.discussionEntryId);
    form.append("file", file, file.name);
    const headers: Record<string, string> = {};
    const key = this.session.getOwnerKey(workspaceId);
    if (key) headers[OWNER_KEY_HEADER] = key;
    const data = await this.send(`/${workspaceId}/materials`, {
      method: "POST",
      headers,
      body: form,
    });
    return z
      .object({ material: materialSchema, created: z.boolean() })
      .transform((value) => ({
        material: value.material,
        reused: !value.created,
      }))
      .parse(data);
  }

  async linkMaterial(
    workspaceId: string,
    taskId: string,
    materialId: string,
  ): Promise<void> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    uuidSchema.parse(materialId);
    await this.request(
      `/${workspaceId}/tasks/${taskId}/material-links`,
      "POST",
      { materialId },
      workspaceId,
    );
  }

  // --- drafts --------------------------------------------------------------

  async listWorkspaceDrafts(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<DraftFile[]> {
    uuidSchema.parse(workspaceId);
    const data = await this.request(
      `/${workspaceId}/drafts`,
      "GET",
      undefined,
      workspaceId,
      signal,
    );
    return z.object({ drafts: z.array(draftFileSchema) }).parse(data).drafts;
  }

  /** Active documents in one task — the editor's file selector (§4.4). */
  async listTaskDrafts(
    workspaceId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<DraftFile[]> {
    uuidSchema.parse(workspaceId);
    uuidSchema.parse(taskId);
    const data = await this.request(
      `/${workspaceId}/tasks/${taskId}/drafts`,
      "GET",
      undefined,
      workspaceId,
      signal,
    );
    return z.object({ drafts: z.array(draftFileSchema) }).parse(data).drafts;
  }

  /**
   * "Edit together" (§2.5). Find-or-create: concurrent clicks on the same file
   * converge on one manual-edit task rather than forking the draft, so a
   * `created: false` response is the normal outcome, not a collision.
   */
  async openDraft(
    workspaceId: string,
    path: string,
    guestLabel: string,
  ): Promise<OpenDraftResponse> {
    uuidSchema.parse(workspaceId);
    return openDraftResponseSchema.parse(
      await this.request(
        `/${workspaceId}/drafts/open`,
        "POST",
        { path, guestLabel },
        workspaceId,
      ),
    );
  }
}

/**
 * Copy for an error code. This file owns every string; none come from the
 * server.
 *
 * The default deliberately says the entered text is still present, because for
 * every form in this app that is true — nothing clears on failure.
 */
export function apiMessage(error: unknown): string {
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
      case "TASK_NOT_FOUND":
        return "This task could not be found. It may have been removed.";
      case "MATERIAL_NOT_FOUND":
        return "That material is recorded but its content is unavailable.";
      case "VALIDATION_FAILED":
        return "Check the highlighted fields before saving.";
      case "TASK_VERSION_CHANGED":
        return "Someone else changed this task while you were editing. Your text is still here — review the latest version and save again.";
      case "TASK_ALREADY_RUNNING":
        return "This task already has an attempt running. Stop it before starting another.";
      case "INVALID_STATE":
        return "That action is not available from this task's current state.";
      case "DOCUMENT_EPOCH_CLOSED":
        return "This document was closed. Your unsent text is still here — open the current draft to continue.";
    }
  }
  return "We could not confirm the request. Your entered text is still here. Check your connection before trying again.";
}

/** Back-compat alias: A02 shipped this name and its tests still import it. */
export const workspaceError = apiMessage;

/** Construct from a validated ID; discard query strings, fragments, and server-supplied URLs. */
export function contributionLink(
  id: string,
  origin = window.location.origin,
): string {
  return new URL(`/w/${uuidSchema.parse(id)}`, origin).href;
}

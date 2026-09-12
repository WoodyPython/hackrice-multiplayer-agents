import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  ApiError, LIVE_TEXT_NAME, draftCaptureSchema, liveRoomPath, liveRoomSchema,
  createDraftRequestSchema, type CollaborationService, type DraftCapture,
  type GitService, type LiveRoomId,
} from '@app/contracts';
import type { PgDraftStore, LoadedDraft } from '../drafts/store.js';
import type { LocalGitService } from '../git/service.js';
import type { PgCheckpointStore } from './checkpoint-store.js';
import { TaskDocumentGate } from './gate.js';
import { LiveRoom, MAX_LIVE_MESSAGE_BYTES } from './room.js';

export interface LiveDocumentDeps {
  drafts: Pick<PgDraftStore, 'resolveRoom' | 'load' | 'initialize' | 'persist'>;
  git: Pick<GitService, 'createDraft' | 'readText'>;
  onError?: (fields: { draftFileId: string; code: 'DRAFT_NOT_SAVED' }) => void;
  debounceMs?: number;
}

export interface CaptureDeps {
  drafts: Pick<PgDraftStore, 'listActiveForTask'>;
  git: Pick<LocalGitService, 'withDraftCapture'>;
  checkpoints: Pick<PgCheckpointStore, 'requireTask' | 'record'>;
}

interface Entry {
  id: LiveRoomId;
  ready: Promise<LiveRoom>;
  room?: LiveRoom;
  users: number;
}

function restore(loaded: LoadedDraft): Y.Doc {
  const doc = new Y.Doc();
  try {
    if (loaded.yjsState === null || loaded.yjsState.byteLength > MAX_LIVE_MESSAGE_BYTES) throw new Error('Invalid snapshot');
    doc.getText(LIVE_TEXT_NAME);
    Y.applyUpdate(doc, loaded.yjsState);
    if ([...doc.share.keys()].some((key) => key !== LIVE_TEXT_NAME)) throw new Error('Unknown shared type');
    const text = doc.getText(LIVE_TEXT_NAME).toString();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024 || text.includes('\0')) throw new Error('Invalid text');
    return doc;
  } catch {
    doc.destroy();
    throw new ApiError('DRAFT_NOT_SAVED', 'The stored shared draft could not be restored.');
  }
}

/** One registry per runtime, shared by WebSocket joins and in-process capture. */
export class LiveDocumentCoordinator implements Pick<CollaborationService, 'capture' | 'isCurrent' | 'closeEpoch'> {
  private readonly entries = new Map<string, Entry>();
  private readonly gates = new TaskDocumentGate();
  private readonly captures = new Set<Promise<DraftCapture>>();
  private stopping = false;
  private closing?: Promise<void>;
  private readonly closedTasks = new Set<string>();
  onAcceptedChange?: (taskId: string, revisionMark: string) => Promise<void>;
  assertWritable?: (taskId: string) => Promise<void>;

  constructor(private readonly deps: LiveDocumentDeps, private readonly captureDeps?: CaptureDeps) {}

  private evict(key: string, entry: Entry): void {
    const room = entry.room;
    if (this.stopping || entry.users !== 0 || !room || room.busy || (room.dirty && !room.closed)) return;
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    room.destroy();
  }

  private async load(id: LiveRoomId): Promise<LoadedDraft> {
    const loaded = await this.deps.drafts.load(id.workspaceId, id.draftFileId);
    if (!loaded || loaded.draftFile.taskId !== id.taskId) throw new ApiError('DRAFT_NOT_FOUND');
    if (loaded.draftFile.status !== 'active' || loaded.draftFile.epoch !== id.epoch) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
    return loaded;
  }

  private async initialize(id: LiveRoomId, key: string, entry: Entry): Promise<LiveRoom> {
    const initial = await this.load(id);
    // Git access precedes the task gate. Capture must never wait on this ready
    // promise while owning Git: a first join could be waiting for that same lock.
    let source: { text: string | null; hash: string | null } | undefined;
    if (initial.yjsState === null) {
      await this.deps.git.createDraft({ workspaceId: id.workspaceId, taskId: id.taskId });
      source = await this.deps.git.readText({
        workspaceId: id.workspaceId, target: { kind: 'draft', taskId: id.taskId },
        path: initial.draftFile.path, allowedPaths: [initial.draftFile.path],
      });
    }
    return this.gates.run(id.taskId, async () => {
      if (this.closedTasks.has(id.taskId)) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      await this.assertWritable?.(id.taskId);
      // An intervening capture may have seeded the row; initialize's database
      // guard returns that winner, never merging an independently seeded copy.
      let loaded = initial;
      if (loaded.yjsState === null) {
        const seed = new Y.Doc();
        try {
          seed.getText(LIVE_TEXT_NAME).insert(0, source?.text ?? '');
          loaded = (await this.deps.drafts.initialize(id.draftFileId, {
            yjsState: Y.encodeStateAsUpdate(seed), stateVector: Y.encodeStateVector(seed), baseBlobSha: source?.hash ?? null,
          })).draft;
        } finally { seed.destroy(); }
      }
      const doc = restore(loaded);
      const room = new LiveRoom({
        draftFileId: id.draftFileId, doc, revision: loaded.draftFile.persistedRevision,
        store: this.deps.drafts, debounceMs: this.deps.debounceMs,
        processUpdate: (operation) => this.gates.run(id.taskId, async () => {
          if (this.closedTasks.has(id.taskId)) { entry.room?.closeEpoch(); return; }
          await this.assertWritable?.(id.taskId);
          const before = entry.room?.revision;
          operation();
          if (entry.room && before !== entry.room.revision) {
            await this.onAcceptedChange?.(id.taskId, `${id.draftFileId}:${entry.room.revision}`).catch(() => this.deps.onError?.({ draftFileId: id.draftFileId, code: 'DRAFT_NOT_SAVED' }));
          }
        }),
        onError: () => this.deps.onError?.({ draftFileId: id.draftFileId, code: 'DRAFT_NOT_SAVED' }),
        onIdle: () => this.evict(key, entry),
      });
      entry.room = room;
      return room;
    });
  }

  async acquire(input: LiveRoomId): Promise<{ room: LiveRoom; release(): void }> {
    if (this.stopping) throw new ApiError('DRAFT_NOT_SAVED', 'The server is shutting down.');
    const parsed = liveRoomSchema.parse(input);
    const id = { ...parsed, workspaceId: parsed.workspaceId.toLowerCase(),
      taskId: parsed.taskId.toLowerCase(), draftFileId: parsed.draftFileId.toLowerCase() };
    if (this.closedTasks.has(id.taskId)) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
    await this.assertWritable?.(id.taskId);
    const draft = await this.deps.drafts.resolveRoom(id);
    if (draft.epoch !== id.epoch) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
    if (this.stopping) throw new ApiError('DRAFT_NOT_SAVED');
    const key = liveRoomPath(id);
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = {
        id, users: 0,
        ready: Promise.resolve().then(() => this.initialize(id, key, created)).catch((error: unknown) => {
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw error;
        }),
      };
      this.entries.set(key, created);
      entry = created;
    }
    const reserved = entry;
    reserved.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reserved.users--;
      if (reserved.users === 0 && reserved.room && !this.stopping) void reserved.room.flush().catch(() => undefined);
    };
    try {
      const room = await reserved.ready;
      const current = await this.deps.drafts.resolveRoom(id);
      if (current.epoch !== id.epoch || room.closed) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      if (this.stopping) throw new ApiError('DRAFT_NOT_SAVED');
      return { room, release };
    } catch (error) { release(); throw error; }
  }

  capture(input: { workspaceId: string; taskId: string }): Promise<DraftCapture> {
    if (this.closedTasks.has(input.taskId.toLowerCase())) return Promise.reject(new ApiError('DOCUMENT_EPOCH_CLOSED'));
    if (this.stopping) return Promise.reject(new ApiError('DRAFT_NOT_SAVED', 'The server is shutting down.'));
    const operation = this.captureDraft(input);
    this.captures.add(operation);
    void operation.then(() => this.captures.delete(operation), () => this.captures.delete(operation));
    return operation;
  }

  private async captureDraft(input: { workspaceId: string; taskId: string }): Promise<DraftCapture> {
    const parsed = createDraftRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Invalid capture request.');
    const workspaceId = parsed.data.workspaceId.toLowerCase(), taskId = parsed.data.taskId.toLowerCase();
    const deps = this.captureDeps;
    if (!deps) throw new ApiError('INVALID_STATE', 'Draft capture is not configured.');
    try {
      await deps.checkpoints.requireTask(workspaceId, taskId);
      return await deps.git.withDraftCapture({ workspaceId, taskId }, (git) => this.gates.run(taskId, async () => {
        if (this.closedTasks.has(taskId)) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
        await this.assertWritable?.(taskId);
        const pinned = [...this.entries.entries()].filter(([, entry]) =>
          entry.id.workspaceId === workspaceId && entry.id.taskId === taskId && entry.room);
        for (const [, entry] of pinned) entry.users++;
        try {
          const drafts = await deps.drafts.listActiveForTask(workspaceId, taskId);
          for (const [, entry] of pinned) {
            if (entry.room!.closed || !drafts.some((draft) => draft.id === entry.id.draftFileId)) {
              throw new ApiError('DOCUMENT_EPOCH_CLOSED');
            }
          }
          const files: Array<{ path: string; text: string }> = [];
          const revisions: Record<string, number> = {};
          for (const draft of drafts) {
            const id = { workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch };
            const room = this.entries.get(liveRoomPath(id))?.room;
            if (room) {
              await room.flush();
              if (room.closed) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
              if (room.dirty || room.persistedRevision !== room.revision) throw new ApiError('DRAFT_NOT_SAVED');
              files.push({ path: draft.path, text: room.doc.getText(LIVE_TEXT_NAME).toString() });
              revisions[draft.id] = room.revision;
            } else {
              let loaded = await this.load(id);
              if (loaded.yjsState === null) {
                const source = await git.readText(draft.path);
                const seed = new Y.Doc();
                try {
                  seed.getText(LIVE_TEXT_NAME).insert(0, source.text ?? '');
                  loaded = (await this.deps.drafts.initialize(draft.id, {
                    yjsState: Y.encodeStateAsUpdate(seed), stateVector: Y.encodeStateVector(seed), baseBlobSha: source.hash,
                  })).draft;
                } finally { seed.destroy(); }
              }
              const doc = restore(loaded);
              try { files.push({ path: draft.path, text: doc.getText(LIVE_TEXT_NAME).toString() }); }
              finally { doc.destroy(); }
              revisions[draft.id] = loaded.draftFile.persistedRevision;
            }
          }
          // Recheck epochs even for clean rooms, which have no pending save to detect closure.
          for (const draft of drafts) await this.deps.drafts.resolveRoom({ workspaceId, taskId, draftFileId: draft.id });
          const { commitSha } = await git.checkpoint(files);
          const documentRevisions = Object.fromEntries(Object.entries(revisions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
          const identity = { taskId, checkpointSha: commitSha, documentRevisions };
          const contextHash = createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
          const result = draftCaptureSchema.parse({ ...identity, contextHash });
          await deps.checkpoints.record(workspaceId, result);
          return result;
        } finally {
          for (const [key, entry] of pinned) { entry.users--; this.evict(key, entry); }
        }
      }));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('DRAFT_NOT_SAVED', 'The draft checkpoint could not be saved. Retry capture.');
    }
  }

  /** Caller takes the workspace Git lock first. Bound checks do not reacquire this gate. */
  withApply<T>(taskId: string, operation: (scope: {
    isCurrent: (revisions: Record<string, number>) => Promise<boolean>;
    close: () => void;
  }) => Promise<T>): Promise<T> {
    taskId = createDraftRequestSchema.shape.taskId.parse(taskId).toLowerCase();
    if (this.stopping) return Promise.reject(new ApiError('DRAFT_NOT_SAVED', 'The server is shutting down.'));
    return this.gates.run(taskId, async () => {
      let active = true;
      const check = () => { if (!active) throw new ApiError('INVALID_STATE', 'Apply scope ended.'); };
      try { return await operation({
        isCurrent: (revisions) => { check(); return this.current(taskId, revisions); },
        close: () => { check(); this.closeInMemory(taskId); },
      }); } finally { active = false; }
    });
  }

  private async current(taskId: string, revisions: Record<string, number>): Promise<boolean> {
    if (this.closedTasks.has(taskId) || !this.captureDeps) return false;
    // Resolve scope through the stored task, never through caller-provided document IDs.
    const ids = Object.keys(revisions);
    const entries = [...this.entries.values()].filter((e) => e.id.taskId === taskId);
    const workspaceId = entries[0]?.id.workspaceId;
    if (!workspaceId) return this.checkUnloaded?.(taskId, revisions) ?? false;
    const drafts = await this.captureDeps.drafts.listActiveForTask(workspaceId, taskId);
    return drafts.length === ids.length && entries.every((e) => !e.room || (!e.room.closed && drafts.some((d) => d.id === e.id.draftFileId))) && drafts.every((d) => {
      const room = entries.find((e) => e.id.draftFileId === d.id)?.room;
      return revisions[d.id] === d.persistedRevision && (!room || (!room.closed && !room.dirty && !room.saveInFlight && room.revision === revisions[d.id]));
    });
  }

  checkUnloaded?: (taskId: string, revisions: Record<string, number>) => Promise<boolean>;
  persistClosure?: (taskId: string) => Promise<void>;

  isCurrent(input: { taskId: string; documentRevisions: Record<string, number> }): Promise<boolean> {
    return this.withApply(input.taskId, (scope) => scope.isCurrent(input.documentRevisions));
  }

  private closeInMemory(taskId: string): void {
    this.closedTasks.add(taskId);
    for (const entry of this.entries.values()) if (entry.id.taskId === taskId) entry.room?.closeEpoch();
  }

  closeEpoch(input: { taskId: string }): Promise<void> {
    const taskId = createDraftRequestSchema.shape.taskId.parse(input.taskId).toLowerCase();
    return this.withApply(taskId, async (scope) => { scope.close(); await this.persistClosure?.(taskId); });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    for (const entry of this.entries.values()) entry.room?.stop();
    this.closing = (async () => {
      await Promise.allSettled([...this.captures, ...[...this.entries.values()].map((entry) => entry.ready)]);
      const rooms = [...this.entries.values()].flatMap((entry) => entry.room ? [entry.room] : []);
      for (const room of rooms) room.stop();
      await this.gates.drain();
      const saved = await Promise.allSettled(rooms.map((room) => room.flush()));
      for (const room of rooms) room.destroy();
      this.entries.clear();
      if (saved.some((result) => result.status === 'rejected')) throw new ApiError('DRAFT_NOT_SAVED');
    })();
    return this.closing;
  }
}

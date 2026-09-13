import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Download,
  FileCheck2,
  FilePlus2,
  ExternalLink,
  FileText,
  PencilRuler,
  Upload,
  X,
} from "lucide-react";
import {
  MAX_MATERIAL_FILE_BYTES,
  isEditableMaterial,
  isSupportedTextExtension,
  type DraftFile,
  type Material,
  type ApprovedFile,
  type ApprovedFileContent,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { useWorkspaceAccess } from "../workspace-access";
import { apiMessage } from "../workspace-api";
import { PageHeading } from "../components/PageHeading";
import { FileTree, type Entry } from "../components/FileTree";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ErrorText, Skeleton } from "../components/ui/misc";

/**
 * The workspace library, as a file explorer (design §3.1–§3.3).
 *
 * This screen used to be four panels side by side: an "edit together" form,
 * active drafts, reference materials, and approved files. That presented one
 * action and three different kinds of file as four equal lists, and showed no
 * structure at all — `documents/a.md` and `documents/deep/b.md` sat in the same
 * flat row list.
 *
 * It is now a tree beside a detail pane, which is the shape people already read
 * without being taught. Nothing was dropped: uploading, opening a file for
 * shared editing, previewing an approved file, jumping to a draft's task, and
 * downloading a material are all still here, moved from panel headers into a
 * toolbar and the detail pane.
 *
 * The one thing deliberately NOT unified is the category split. "Edit together"
 * became a toolbar action because it is an action and never was a category, and
 * the three file kinds stay separate top-level folders because they answer to
 * different rules — see FileTree for why materials cannot be spliced into
 * `documents/`.
 */

const CATEGORY = {
  approved: {
    label: "Approved files",
    blurb: "Published to everyone. Applying a reviewed change adds to these.",
  },
  draft: {
    label: "Shared drafts",
    blurb: "Being written now. Everyone with the link edits the same text.",
  },
  material: {
    label: "Reference materials",
    blurb: "Immutable uploads that can be previewed here; text files can also become shared drafts.",
  },
} as const;

/** Category order is meaningful: published, then in progress, then inputs. */
const ROOTS = [
  CATEGORY.approved.label,
  CATEGORY.draft.label,
  CATEGORY.material.label,
] as const;

export function Files({ workspaceId }: { workspaceId: string }) {
  const { api, session } = useBrowser();
  const gate = useWorkspaceAccess();
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<ApprovedFile[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<ApprovedFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      api.listMaterials(workspaceId, controller.signal),
      api.listWorkspaceDrafts(workspaceId, controller.signal),
      api.listApprovedFiles(workspaceId, controller.signal),
    ])
      .then(([mats, drafted, files]) => {
        if (controller.signal.aborted) return;
        setMaterials(mats);
        setDrafts(drafted);
        setApproved(files.files);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, workspaceId, nonce]);

  async function upload(files: File[]) {
    if (files.length === 0 || busy) return;
    setUploadError(null);
    setUploadMessage(null);
    setBusy(true);

    const supported = files.filter(
      (file) => file.size > 0 && file.size <= MAX_MATERIAL_FILE_BYTES,
    );
    const skipped = files.filter((file) => !supported.includes(file));
    let uploaded = 0;
    let reused = 0;
    const failed: string[] = [];

    setUploadProgress({ completed: 0, total: supported.length });
    try {
      // Keep the requests sequential. Folder drops can contain hundreds of
      // files, and turning all of them into simultaneous multipart requests
      // would overwhelm the API and make useful progress feedback impossible.
      for (const [index, file] of supported.entries()) {
        try {
          const result = await api.uploadMaterial(
            workspaceId,
            file,
            session.getGuest().name,
          );
          if (result.reused) reused += 1;
          else uploaded += 1;
        } catch (error) {
          failed.push(`${file.name} (${apiMessage(error)})`);
        }
        setUploadProgress({ completed: index + 1, total: supported.length });
      }

      if (uploaded + reused > 0) reload();

      const completed = uploaded + reused;
      if (completed > 0) {
        const parts = [
          `${uploaded} ${uploaded === 1 ? "material" : "materials"} uploaded`,
        ];
        if (reused > 0) parts.push(`${reused} already present`);
        setUploadMessage(`${parts.join(", ")}.`);
      }

      if (skipped.length > 0 || failed.length > 0) {
        const issues = [
          ...skipped.map((file) => `${file.name} (unsupported, empty, or over the size limit)`),
          ...failed,
        ];
        const shown = issues.slice(0, 3).join(", ");
        const remaining = issues.length - 3;
        setUploadError(
          `${issues.length} ${issues.length === 1 ? "file was" : "files were"} not uploaded: ${shown}${remaining > 0 ? `, and ${remaining} more` : ""}.`,
        );
      } else if (supported.length === 0) {
        setUploadError("No non-empty files within the size limit were found.");
      }
    } finally {
      setBusy(false);
      setUploadProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function dropFiles(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    if (busy) return;
    try {
      const files = await filesFromDrop(event.dataTransfer);
      if (files.length === 0) {
        setUploadMessage(null);
        setUploadError("No files were found in that drop.");
        return;
      }
      await upload(files);
    } catch {
      setUploadMessage(null);
      setUploadError("That folder could not be read. Try dropping it again.");
    }
  }

  async function editTogether(target: string, materialId?: string) {
    if (!target.trim()) return;
    setOpenError(null);
    setBusy(true);
    try {
      const result = await api.openDraft(
        workspaceId,
        target.trim(),
        session.getGuest().name,
        materialId,
      );
      navigate(`/w/${workspaceId}/tasks/${result.taskId}/drafts`);
    } catch (error) {
      setOpenError(apiMessage(error));
      setBusy(false);
    }
  }

  async function viewFile(target: string) {
    setBusy(true);
    setOpenError(null);
    try {
      setPreview(await api.readApprovedFile(workspaceId, target));
    } catch (error) {
      setOpenError(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const live = materials.filter((material) => material.deletedAt === null);
  const entries: Entry[] = [
    ...approved.map(
      (file): Entry => ({
        kind: "approved",
        name: file.path,
        path: `${CATEGORY.approved.label}/${file.path}`,
        file,
      }),
    ),
    ...drafts.map(
      (draft): Entry => ({
        kind: "draft",
        name: draft.path,
        path: `${CATEGORY.draft.label}/${draft.path}`,
        draft,
      }),
    ),
    ...live.map(
      (material): Entry => ({
        kind: "material",
        name: material.filename,
        // Flat on purpose: a material has a filename and no repository path.
        path: `${CATEGORY.material.label}/${material.filename}`,
        material,
      }),
    ),
  ];

  function select(entry: Entry) {
    setSelected(entry);
    setPreview(null);
    setOpenError(null);
    if (entry.kind === "approved") void viewFile(entry.file.path);
  }

  return (
    <>
      <PageHeading
        eyebrow="Your shared library"
        title="Files"
        description="Reference materials to draw on, and documents being written now."
      />

      {failure && (
        <div role="alert" className="mb-5 flex flex-wrap items-center gap-3">
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {/*
        "Edit a file together" and the upload dropzone both write. A viewer keeps
        the file tree and every preview -- reading is the whole point of sharing
        a link -- and gets the reason where the controls were.
      */}
      {!gate.canWrite ? (
        <p className="mb-4 text-[12.5px] text-muted-foreground">{gate.readOnlyReason}</p>
      ) : (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => setCreating((open) => !open)}
          aria-expanded={creating}
        >
          <FilePlus2 aria-hidden="true" />
          Edit a file together
        </Button>
        <label
          className={`inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-[12.5px] font-medium transition-[color,background-color,border-color,box-shadow] ${
            busy
              ? "cursor-not-allowed opacity-60"
              : draggingFiles
                ? "cursor-copy border-navy-500 bg-navy-50 ring-2 ring-navy-500/20 dark:bg-navy-950/60"
                : "cursor-pointer border-border hover:bg-muted"
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? "none" : "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDraggingFiles(false);
            }
          }}
          onDrop={(event) => void dropFiles(event)}
        >
          <Upload aria-hidden="true" className="size-3.5" />
          <span>
            {uploadProgress
              ? `Uploading ${uploadProgress.completed} of ${uploadProgress.total}…`
              : draggingFiles
                ? "Drop files or folders"
                : "Upload materials"}
          </span>
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            multiple
            disabled={busy}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) void upload(files);
            }}
          />
        </label>
        <small className="text-[11px] text-muted-foreground">
          Choose multiple files, or drop files and folders here. Any type, up to{" "}
          {Math.round(MAX_MATERIAL_FILE_BYTES / 1024 / 1024)} MB each. Non-text files stay read-only.
        </small>
      </div>
      )}

      {creating && (
        <section className="mb-4 max-w-md rounded-xl border border-border bg-card p-3 shadow-xs" aria-label="Choose a file to edit together">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <div>
              <h2 className="text-[13px] font-semibold">Choose a file</h2>
              <p className="text-[11.5px] text-muted-foreground">Select an approved file or reference material to open in the shared editor.</p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => setCreating(false)} aria-label="Close file picker">
              <X aria-hidden="true" />
            </Button>
          </div>
          {approved.length > 0 || live.some(isEditableMaterial) ? (
            <FileTree
              entries={entries.filter((entry) => entry.kind === "approved" || (entry.kind === "material" && isEditableMaterial(entry.material)))}
              roots={[CATEGORY.approved.label, CATEGORY.material.label]}
              selected={null}
              onSelect={(entry) => {
                setCreating(false);
                if (entry.kind === "approved") void editTogether(entry.file.path);
                if (entry.kind === "material") void editTogether(`documents/${entry.material.filename}`, entry.material.id);
              }}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[12px] text-muted-foreground">
              No approved files or reference materials are available yet.
            </p>
          )}
        </section>
      )}

      {uploadError && (
        <ErrorText role="alert" className="mb-4">
          {uploadError}
        </ErrorText>
      )}
      {uploadMessage && (
        <p role="status" className="mb-4 text-[12px] text-muted-foreground">
          {uploadMessage}
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <nav
          aria-label="Workspace files"
          className="rounded-xl border border-border bg-card p-2 shadow-xs"
        >
          {loading ? (
            <div aria-hidden="true" className="space-y-2 p-2">
              <Skeleton className="h-6" />
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : (
            <FileTree
              entries={entries}
              roots={ROOTS}
              selected={selected?.path ?? null}
              onSelect={select}
            />
          )}
          {loading && (
            <p role="status" className="sr-only">
              Loading files…
            </p>
          )}
        </nav>

        <section className="min-h-[16rem] rounded-xl border border-border bg-card p-5 shadow-xs">
          {openError && (
            <ErrorText role="alert" className="mb-3">
              {openError}
            </ErrorText>
          )}
          {!selected ? (
            <div className="grid h-full place-items-center py-10 text-center">
              <div className="max-w-sm">
                <h2 className="text-[15px] font-semibold tracking-tight">
                  Select a file
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  {CATEGORY.approved.blurb} {CATEGORY.draft.blurb}{" "}
                  {CATEGORY.material.blurb}
                </p>
              </div>
            </div>
          ) : (
            <Detail
              entry={selected}
              preview={preview}
              busy={busy}
              workspaceId={workspaceId}
              onEditTogether={editTogether}
              onOpenTask={(taskId) =>
                navigate(`/w/${workspaceId}/tasks/${taskId}/drafts`)
              }
              onClosePreview={() => setPreview(null)}
            />
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Expands dropped directories using the browser's drag-and-drop entry API.
 * The regular picker remains a standard `multiple` input, so one control can
 * accept loose files by click and whole folders by drop without a mode toggle.
 */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length === 0) return Array.from(dataTransfer.files ?? []);

  const nested = await Promise.all(entries.map(readDroppedEntry));
  return nested.flat();
}

async function readDroppedEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [file];
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // Chromium returns large directories in batches, so read until the first
  // empty batch rather than assuming one call contains the whole folder.
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(readDroppedEntry))).flat();
}

function Detail({
  entry,
  preview,
  busy,
  workspaceId,
  onEditTogether,
  onOpenTask,
  onClosePreview,
}: {
  entry: Entry;
  preview: ApprovedFileContent | null;
  busy: boolean;
  workspaceId: string;
  onEditTogether: (path: string, materialId?: string) => void;
  onOpenTask: (taskId: string) => void;
  onClosePreview: () => void;
}) {
  const Icon =
    entry.kind === "approved"
      ? FileCheck2
      : entry.kind === "draft"
        ? PencilRuler
        : FileText;
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start gap-3 border-b border-border pb-4">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight break-all">
            {entry.name}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {CATEGORY[entry.kind].label} · {CATEGORY[entry.kind].blurb}
          </p>
        </div>
      </header>

      {entry.kind === "approved" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onEditTogether(entry.file.path)}
            >
              <PencilRuler aria-hidden="true" />
              Edit together
            </Button>
            {/* The pane below is for peeking while you browse; this is the
                linkable full-page reader, so a file can be sent to someone. */}
            <Link
              to={`/w/${workspaceId}/files/view?path=${encodeURIComponent(entry.file.path)}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              Open full page
            </Link>
          </div>
          {preview && (
            <section className="space-y-2 rounded-lg border border-border bg-muted/30 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                {/* The path is already the detail heading above; repeating it
                    here just gave the same name to two headings. */}
                <h3 className="text-[13px] font-semibold">Approved contents</h3>
                <Badge size="sm" className="font-mono">
                  {preview.mainSha.slice(0, 8)}
                </Badge>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={onClosePreview}
                >
                  <X aria-hidden="true" />
                  <span className="sr-only">Close preview</span>
                </Button>
              </div>
              <pre className="max-h-96 overflow-auto rounded-lg bg-card p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                {preview.text ??
                  "This file is no longer on the approved version. Refresh the list."}
              </pre>
            </section>
          )}
        </>
      )}

      {entry.kind === "draft" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => onOpenTask(entry.draft.taskId)}
          >
            <PencilRuler aria-hidden="true" />
            Open in the editor
          </Button>
          <Badge size="sm">revision {entry.draft.persistedRevision}</Badge>
        </div>
      )}

      {entry.kind === "material" && (
        <div className="flex flex-wrap items-center gap-3">
          {isEditableMaterial(entry.material) && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onEditTogether(`documents/${entry.material.filename}`, entry.material.id)}
            >
              <PencilRuler aria-hidden="true" />
              Edit together
            </Button>
          )}
          <a
            href={`/api/workspaces/${workspaceId}/materials/${entry.material.id}`}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted"
          >
            <Download aria-hidden="true" className="size-3.5" />
            Download
          </a>
          <small className="text-[11.5px] text-muted-foreground">
            {Math.max(1, Math.round(entry.material.byteSize / 1024))} KB
            {entry.material.guestLabel ? ` · added by ${entry.material.guestLabel}` : ""}
          </small>
          {!isEditableMaterial(entry.material) && (
            <Badge size="sm">read-only</Badge>
          )}
        </div>
      )}
      {entry.kind === "material" && (
        <MaterialPreview workspaceId={workspaceId} material={entry.material} />
      )}
    </div>
  );
}

function MaterialPreview({ workspaceId, material }: { workspaceId: string; material: Material }) {
  const { api } = useBrowser();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; text?: string; url?: string; hex?: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    void api.readMaterial(workspaceId, material.id, controller.signal)
      .then(async (bytes) => {
        if (controller.signal.aborted) return;
        if (isSupportedTextExtension(material.filename) || material.contentType === "image/svg+xml") {
          const text = await new Response(bytes).text();
          if (!controller.signal.aborted) setState({ status: "ready", text });
          return;
        }
        const typed = new Blob([bytes], { type: material.contentType });
        if (
          material.contentType === "application/pdf" ||
          material.contentType.startsWith("image/") ||
          material.contentType.startsWith("audio/") ||
          material.contentType.startsWith("video/")
        ) {
          objectUrl = URL.createObjectURL(typed);
          setState({ status: "ready", url: objectUrl });
          return;
        }
        const sample = new Uint8Array(bytes.slice(0, 256));
        setState({
          status: "ready",
          hex: Array.from(sample, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: apiMessage(error) });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, workspaceId, material.id, material.filename, material.contentType]);

  return (
    <section className="space-y-2 rounded-lg border border-border bg-muted/30 p-3.5" aria-label={`Preview of ${material.filename}`}>
      <h3 className="text-[13px] font-semibold">Preview</h3>
      {state.status === "loading" && <Skeleton className="h-40" />}
      {state.status === "error" && <ErrorText role="alert">{state.message}</ErrorText>}
      {state.status === "ready" && state.text !== undefined && (
        <pre className="max-h-96 overflow-auto rounded-lg bg-card p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{state.text}</pre>
      )}
      {state.status === "ready" && state.url && material.contentType.startsWith("image/") && (
        <img loading="lazy" src={state.url} alt={material.filename} className="max-h-[32rem] w-full rounded-lg bg-card object-contain" />
      )}
      {state.status === "ready" && state.url && material.contentType === "application/pdf" && (
        <iframe loading="lazy" title={`Preview of ${material.filename}`} src={state.url} className="h-[32rem] w-full rounded-lg border border-border bg-white" />
      )}
      {state.status === "ready" && state.url && material.contentType.startsWith("audio/") && (
        <audio aria-label={`Preview of ${material.filename}`} controls src={state.url} className="w-full" />
      )}
      {state.status === "ready" && state.url && material.contentType.startsWith("video/") && (
        <video aria-label={`Preview of ${material.filename}`} controls src={state.url} className="max-h-[32rem] w-full rounded-lg bg-black" />
      )}
      {state.status === "ready" && state.hex !== undefined && (
        <div className="space-y-2 rounded-lg bg-card p-3">
          <p className="text-[12px] text-muted-foreground">This format has no browser-native visual preview. Showing the first {Math.min(material.byteSize, 256)} bytes.</p>
          <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{state.hex || "No preview bytes available."}</pre>
        </div>
      )}
    </section>
  );
}

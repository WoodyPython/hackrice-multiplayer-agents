import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Download,
  FileCheck2,
  FilePlus2,
  FileText,
  PencilRuler,
  Upload,
  X,
} from "lucide-react";
import {
  MAX_TEXT_FILE_BYTES,
  SUPPORTED_TEXT_EXTENSIONS,
  type DraftFile,
  type Material,
  type ApprovedFile,
  type ApprovedFileContent,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { PageHeading } from "../components/PageHeading";
import { FileTree, type Entry } from "../components/FileTree";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
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
    blurb: "Immutable uploads for tasks to read. Never edited in place.",
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
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<ApprovedFile[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<ApprovedFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [path, setPath] = useState("");
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

  async function upload(file: File) {
    setUploadError(null);
    setBusy(true);
    try {
      await api.uploadMaterial(workspaceId, file, session.getGuest().name);
      reload();
    } catch (error) {
      setUploadError(apiMessage(error));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function editTogether(target: string) {
    if (!target.trim()) return;
    setOpenError(null);
    setBusy(true);
    try {
      const result = await api.openDraft(
        workspaceId,
        target.trim(),
        session.getGuest().name,
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
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted">
          <Upload aria-hidden="true" className="size-3.5" />
          <span>Upload a material</span>
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            accept={SUPPORTED_TEXT_EXTENSIONS.join(",")}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        <small className="text-[11px] text-muted-foreground">
          Text only, up to {Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB.
        </small>
      </div>

      {creating && (
        <form
          className="mb-4 flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void editTogether(path);
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="edit-path">File path</Label>
            <Input
              id="edit-path"
              autoFocus
              value={path}
              placeholder="documents/launch.md"
              onChange={(event) => setPath(event.target.value)}
              className="font-mono text-[12.5px]"
            />
          </div>
          <Button variant="primary" type="submit" disabled={busy || !path.trim()}>
            {busy ? "Opening…" : "Open for editing"}
          </Button>
        </form>
      )}

      {uploadError && (
        <ErrorText role="alert" className="mb-4">
          {uploadError}
        </ErrorText>
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
  onEditTogether: (path: string) => void;
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
        </div>
      )}
    </div>
  );
}

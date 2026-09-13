import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Download,
  FileCheck2,
  FileText,
  FolderOpen,
  PencilRuler,
  Upload,
  Users,
} from "lucide-react";
import {
  MAX_TEXT_FILE_BYTES,
  SUPPORTED_TEXT_EXTENSIONS,
  type DraftFile,
  type Material,
  type ApprovedFile,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";
import { PageHeading } from "../components/PageHeading";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
import { ErrorText, Path, Skeleton } from "../components/ui/misc";

function Panel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof FileText;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <div className="flex items-start gap-3 border-b border-border p-5">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-3 p-5">{children}</div>
    </section>
  );
}

function FileRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12.5px]">
      {children}
    </li>
  );
}

/** Approved main, immutable references, and active collaborative drafts. */
export function Files({ workspaceId }: { workspaceId: string }) {
  const { api, session } = useBrowser();
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<ApprovedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [path, setPath] = useState("");
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

  const live = materials.filter((material) => material.deletedAt === null);

  const listSkeleton = (
    <div aria-hidden="true" className="space-y-2">
      <Skeleton className="h-9" />
      <Skeleton className="h-9 w-3/4" />
    </div>
  );

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

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          icon={PencilRuler}
          title="Edit together"
          description="Open a file for shared editing. Everyone with the workspace link edits the same document, and it can be reviewed without starting any agents."
        >
          <form
            className="flex flex-col gap-2.5 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void editTogether(path);
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="edit-path">File path</Label>
              <Input
                id="edit-path"
                value={path}
                placeholder="documents/launch.md"
                onChange={(event) => setPath(event.target.value)}
                className="font-mono text-[12.5px]"
              />
            </div>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !path.trim()}
            >
              {busy ? "Opening…" : "Edit together"}
            </Button>
          </form>
          {openError && <ErrorText role="alert">{openError}</ErrorText>}
        </Panel>

        <Panel icon={Users} title="Active shared drafts">
          {loading ? (
            <>
              <p role="status" className="sr-only">
                Loading files…
              </p>
              {listSkeleton}
            </>
          ) : drafts.length === 0 ? (
            <EmptyState title="Nothing is being edited right now" icon={Users}>
              Open a file above and it will appear here for everyone.
            </EmptyState>
          ) : (
            <ul className="grid gap-2">
              {drafts.map((draft) => (
                <FileRow key={draft.id}>
                  <FileText
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <Link
                    to={`/w/${workspaceId}/tasks/${draft.taskId}/drafts`}
                    className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
                  >
                    {draft.path}
                  </Link>
                  <Badge size="sm" className="ml-auto">
                    revision {draft.persistedRevision}
                  </Badge>
                </FileRow>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          icon={FolderOpen}
          title="Reference materials"
          description={`Text only — Markdown, plain text, and code, up to ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB. PDFs and images are rejected.`}
        >
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-[12.5px] font-medium transition-colors hover:bg-muted">
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

          {uploadError && <ErrorText role="alert">{uploadError}</ErrorText>}

          {loading ? null : live.length === 0 ? (
            <EmptyState title="No reference materials yet" icon={FolderOpen}>
              Upload the brief, the notes, the half-finished draft — whatever a
              task should read before it starts.
            </EmptyState>
          ) : (
            <ul className="grid gap-2">
              {live.map((material) => (
                <FileRow key={material.id}>
                  <FileText
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <a
                    href={`/api/workspaces/${workspaceId}/materials/${material.id}`}
                    download
                    className="flex min-w-0 items-center gap-1.5 truncate font-medium underline-offset-2 hover:underline"
                  >
                    {material.filename}
                    <Download aria-hidden="true" className="size-3 shrink-0" />
                  </a>
                  <small className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {Math.max(1, Math.round(material.byteSize / 1024))} KB
                    {material.guestLabel ? ` · ${material.guestLabel}` : ""}
                  </small>
                </FileRow>
              ))}
            </ul>
          )}
        </Panel>

        <Panel icon={FileCheck2} title="Approved files">
          {loading ? (
            <>
              <p role="status" className="sr-only">
                Loading approved files…
              </p>
              {listSkeleton}
            </>
          ) : approved.length === 0 ? (
            <EmptyState title="No approved files yet" icon={FileCheck2}>
              Apply a reviewed change to publish files here.
            </EmptyState>
          ) : (
            <ul className="grid gap-2">
              {approved.map((file) => (
                <FileRow key={file.path}>
                  <Link
                    to={`/w/${workspaceId}/files/view?path=${encodeURIComponent(file.path)}`}
                    className="min-w-0 truncate font-mono text-[11.5px] font-medium underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    {file.path}
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => void editTogether(file.path)}
                  >
                    Edit {file.path} together
                  </Button>
                </FileRow>
              ))}
            </ul>
          )}

        </Panel>
      </div>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { EmptyState } from "../components/EmptyState";

/** Approved main, immutable references, and active collaborative drafts. */
export function Files({ workspaceId }: { workspaceId: string }) {
  const { api, session } = useBrowser();
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<ApprovedFile[]>([]);
  const [preview, setPreview] = useState<ApprovedFileContent | null>(null);
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

  async function viewFile(target: string) {
    setBusy(true);
    setOpenError(null);
    try { setPreview(await api.readApprovedFile(workspaceId, target)); }
    catch (error) { setOpenError(apiMessage(error)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Your shared library</span>
          <h1>Files</h1>
          <p>Reference materials to draw on, and documents being written now.</p>
        </div>
      </header>

      {failure && (
        <div role="alert">
          <p className="error">{failure}</p>
          <button onClick={reload}>Try again</button>
        </div>
      )}

      <section className="panel">
        <h2>Edit together</h2>
        <p className="muted">
          Open a file for shared editing. Everyone with the workspace link edits
          the same document, and it can be reviewed without starting any agents.
        </p>
        <form
          className="edit-together"
          onSubmit={(event) => {
            event.preventDefault();
            void editTogether(path);
          }}
        >
          <label htmlFor="edit-path">File path</label>
          <input
            id="edit-path"
            value={path}
            placeholder="documents/launch.md"
            onChange={(event) => setPath(event.target.value)}
          />
          <button className="primary" type="submit" disabled={busy || !path.trim()}>
            {busy ? "Opening…" : "Edit together"}
          </button>
        </form>
        {openError && (
          <p role="alert" className="error">
            {openError}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Active shared drafts</h2>
        {loading ? (
          <p role="status">Loading files…</p>
        ) : drafts.length === 0 ? (
          <EmptyState title="Nothing is being edited right now">
            Open a file above and it will appear here for everyone.
          </EmptyState>
        ) : (
          <ul className="file-list">
            {drafts.map((draft) => (
              <li key={draft.id}>
                ▤{" "}
                <Link to={`/w/${workspaceId}/tasks/${draft.taskId}/drafts`}>
                  {draft.path}
                </Link>
                <small className="muted"> · revision {draft.persistedRevision}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Reference materials</h2>
        <p className="muted">
          Text only — Markdown, plain text, and code, up to{" "}
          {Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB. PDFs and images are
          rejected.
        </p>
        <label className="attach-control">
          <span>Upload a material</span>
          <input
            ref={fileInput}
            type="file"
            accept={SUPPORTED_TEXT_EXTENSIONS.join(",")}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        {uploadError && (
          <p role="alert" className="error">
            {uploadError}
          </p>
        )}
        {loading ? null : live.length === 0 ? (
          <EmptyState title="No reference materials yet">
            Upload the brief, the notes, the half-finished draft — whatever a
            task should read before it starts.
          </EmptyState>
        ) : (
          <ul className="file-list">
            {live.map((material) => (
              <li key={material.id}>
                ▤ <a href={`/api/workspaces/${workspaceId}/materials/${material.id}`} download>{material.filename}</a>
                <small className="muted">
                  {" "}
                  · {Math.max(1, Math.round(material.byteSize / 1024))} KB
                  {material.guestLabel ? ` · ${material.guestLabel}` : ""}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Approved files</h2>
        {loading ? <p role="status">Loading approved files…</p> : approved.length === 0 ? (
          <EmptyState title="No approved files yet">Apply a reviewed change to publish files here.</EmptyState>
        ) : <ul className="file-list">{approved.map((file) => <li key={file.path}>
          <button disabled={busy} onClick={() => void viewFile(file.path)}>{file.path}</button>{" "}
          <button disabled={busy} onClick={() => void editTogether(file.path)}>Edit {file.path} together</button>
        </li>)}</ul>}
        {preview && <section aria-label="Approved file preview">
          <h3>{preview.path}</h3>
          <p className="muted">Approved version {preview.mainSha.slice(0, 8)}</p>
          <pre className="file-preview">{preview.text ?? "This file is no longer on the approved version. Refresh the list."}</pre>
          <button onClick={() => setPreview(null)}>Close preview</button>
        </section>}
      </section>
    </>
  );
}

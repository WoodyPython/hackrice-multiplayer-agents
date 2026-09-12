import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  MAX_TEXT_FILE_BYTES,
  SUPPORTED_TEXT_EXTENSIONS,
  type DraftFile,
  type Material,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";

/**
 * The Files screen (design §4.1, §3.2, §2.5).
 *
 * §4.1 asks for three sections: approved files, reference materials, and active
 * shared drafts. Two are built.
 *
 * **Approved files are absent, and the page says so rather than showing an
 * empty list.** Nothing in the system can enumerate what is on main: the Git
 * service exposes `readText(path)` for one known path and has no tree or list
 * operation, so there is no route to call and no contract to call it with. An
 * empty "Approved files" heading would read as "this workspace has approved
 * nothing", which is a different and unfounded claim.
 *
 * **Edit together** (§2.5) is find-or-create: concurrent opens of the same path
 * converge on one manual-edit task rather than forking the draft, so a reused
 * task is the normal outcome and is not reported as a collision.
 */
export function Files({ workspaceId }: { workspaceId: string }) {
  const { api, session } = useBrowser();
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
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
    ])
      .then(([mats, drafted]) => {
        if (controller.signal.aborted) return;
        setMaterials(mats);
        setDrafts(drafted);
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
            placeholder="docs/launch.md"
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
                ▤ {material.filename}
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
        <EmptyState title="Not available yet">
          Approved files live in Git, and nothing in the system can list them
          yet — reading one requires knowing its exact path. This section will
          fill in when a listing endpoint exists. It does not mean the workspace
          has approved nothing.
        </EmptyState>
      </section>
    </>
  );
}

import { useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  updateWorkspaceRequestSchema,
  type Workspace,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { workspaceError } from "../workspace-api";

export function WorkspaceSettings({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: (value: Workspace) => void;
}) {
  const { api, session } = useBrowser();
  const [name, setName] = useState(workspace.name);
  const [purpose, setPurpose] = useState(workspace.purpose);
  const [guidance, setGuidance] = useState(workspace.guidance);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const canEdit = workspace.isOwner && !!session.getOwnerKey(workspace.id);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !canEdit) return;
    const parsed = updateWorkspaceRequestSchema.safeParse({
      name,
      purpose,
      guidance,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setError("");
    setMessage("");
    busy.current = true;
    setPending(true);
    try {
      onChange(await api.update(workspace.id, parsed.data));
      setMessage("Workspace settings saved.");
    } catch (cause) {
      setError(workspaceError(cause));
      if (cause instanceof ApiError && cause.code === "OWNER_KEY_REQUIRED")
        onChange({ ...workspace, isOwner: false });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Workspace settings</span>
          <h1>{workspace.name}</h1>
          <p>{workspace.purpose}</p>
        </div>
      </header>
      <form className="panel requirement-form" onSubmit={save} noValidate>
        <h2>Workspace guidance</h2>
        {!canEdit && (
          <p role="status">
            Owner controls are unavailable in this browser. You can still
            participate through the workspace link. If browser storage was
            cleared, owner access cannot be recovered.
          </p>
        )}
        <label htmlFor="settings-name">Workspace name</label>
        <input
          id="settings-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          readOnly={!canEdit}
          maxLength={200}
        />
        <label htmlFor="settings-purpose">Purpose</label>
        <textarea
          id="settings-purpose"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          readOnly={!canEdit}
          rows={3}
          maxLength={4000}
        />
        <label htmlFor="settings-guidance">Guidance</label>
        <textarea
          id="settings-guidance"
          value={guidance}
          onChange={(event) => setGuidance(event.target.value)}
          readOnly={!canEdit}
          rows={6}
          maxLength={20000}
        />
        <small>
          Guidance version {workspace.guidanceVersion}. Display names do not
          grant owner access.
        </small>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {canEdit && (
          <button className="primary" disabled={pending} type="submit">
            {pending ? "Saving…" : "Save workspace settings"}
          </button>
        )}
      </form>
    </>
  );
}

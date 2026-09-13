import { useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import {
  ApiError,
  updateWorkspaceRequestSchema,
  type Workspace,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { workspaceError } from "../workspace-api";
import { PageHeading } from "../components/PageHeading";
import { Button } from "../components/ui/button";
import { Input, Label, Textarea } from "../components/ui/field";
import { ErrorText, Notice } from "../components/ui/misc";

export function WorkspaceSettings({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: (value: Workspace) => void;
}) {
  const { api, session } = useBrowser();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(
    workspace.guidance || workspace.purpose,
  );
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
      purpose: description,
      guidance: description,
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
      <PageHeading
        eyebrow="Workspace settings"
        title={workspace.name}
        description={workspace.purpose}
      />

      <form
        className="max-w-2xl space-y-5 rounded-xl border border-border bg-card p-6 shadow-xs"
        onSubmit={save}
        noValidate
      >
        <h2 className="text-[17px] font-semibold tracking-tight">
          Workspace details
        </h2>

        {!canEdit && (
          <Notice role="status" tone="warn">
            <p className="flex gap-2">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Host controls are unavailable in this browser. You can still
                participate through the workspace link. If browser storage was
                cleared, host access cannot be recovered.
              </span>
            </p>
          </Notice>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="settings-name">Workspace name</Label>
          <Input
            id="settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            readOnly={!canEdit}
            maxLength={200}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-description">Description</Label>
          <Textarea
            id="settings-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            readOnly={!canEdit}
            rows={6}
            maxLength={20000}
          />
        </div>

        {error && <ErrorText role="alert">{error}</ErrorText>}
        {message && (
          <p
            role="status"
            className="text-[13px] font-medium text-emerald-700 dark:text-emerald-400"
          >
            {message}
          </p>
        )}

        {canEdit && (
          <Button variant="primary" disabled={pending} type="submit">
            {pending ? "Saving…" : "Save workspace settings"}
          </Button>
        )}
      </form>
    </>
  );
}

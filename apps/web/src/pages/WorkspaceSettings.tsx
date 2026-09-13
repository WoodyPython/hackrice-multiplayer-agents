import { useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import {
  ApiError,
  updateWorkspaceRequestSchema,
  type Workspace,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { Members } from "../components/Members";
import { workspaceError } from "../workspace-api";
import { PageHeading } from "../components/PageHeading";
import { Button } from "../components/ui/button";
import { Input, Label, Textarea } from "../components/ui/field";
import { Badge } from "../components/ui/badge";
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
  const [purpose, setPurpose] = useState(workspace.purpose);
  const [guidance, setGuidance] = useState(workspace.guidance);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const canEdit = workspace.isOwner;

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
      <PageHeading
        eyebrow="Workspace settings"
        title={workspace.name}
        description={workspace.purpose}
        actions={
          <Badge tone={canEdit ? "brand" : "neutral"}>
            {canEdit ? "Owner" : "Read only"}
          </Badge>
        }
      />

      <form
        className="max-w-2xl space-y-5 rounded-xl border border-border bg-card p-6 shadow-xs"
        onSubmit={save}
        noValidate
      >
        <h2 className="text-[17px] font-semibold tracking-tight">
          Workspace guidance
        </h2>

        {!canEdit && (
          <Notice role="status" tone="warn">
            <p className="flex gap-2">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Owner controls are unavailable in this browser. You can still
                participate through the workspace link. If browser storage was
                cleared, owner access cannot be recovered.
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
          <Label htmlFor="settings-purpose">Purpose</Label>
          <Textarea
            id="settings-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            readOnly={!canEdit}
            rows={3}
            maxLength={4000}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-guidance">Guidance</Label>
          <Textarea
            id="settings-guidance"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
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

      <div className="mt-8">
        <Members workspaceId={workspace.id} isOwner={workspace.isOwner} />
      </div>
    </>
  );
}

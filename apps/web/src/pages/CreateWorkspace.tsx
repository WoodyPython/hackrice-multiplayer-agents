import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createWorkspaceRequestSchema } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { workspaceError } from "../workspace-api";
import { workspace as sample } from "../fixtures";

export function CreateWorkspace() {
  const { api } = useBrowser();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const parsed = createWorkspaceRequestSchema.safeParse({
      name: data.get("name"),
      purpose: data.get("purpose"),
    });
    if (!parsed.success) {
      setFields(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setFields({});
    setError("");
    submitting.current = true;
    setPending(true);
    try {
      const id = await api.create(parsed.data);
      navigate(`/w/${id}`);
    } catch (cause) {
      setError(workspaceError(cause));
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <main className="welcome create-workspace">
      <Link className="brand" to="/">
        <span className="brand-mark">c</span>common.
      </Link>
      <span className="eyebrow">A little more possible, together</span>
      <h1>
        Make room
        <br />
        for good work.
      </h1>
      <p>
        Create a shared workspace. Invite collaborators with a link and shape
        the work together.
      </p>
      <form className="panel requirement-form" onSubmit={create} noValidate>
        <h2>Create a workspace</h2>
        <label htmlFor="workspace-name">Workspace name</label>
        <input
          id="workspace-name"
          name="name"
          maxLength={200}
          placeholder="Our launch room"
          aria-invalid={!!fields.name}
          aria-describedby={fields.name ? "name-error" : undefined}
        />
        {fields.name && (
          <small className="error" id="name-error">
            {fields.name}
          </small>
        )}
        <label htmlFor="workspace-purpose">
          Purpose <span className="required">Optional</span>
        </label>
        <textarea
          id="workspace-purpose"
          name="purpose"
          maxLength={4000}
          rows={3}
          placeholder="What will you work on together?"
        />
        <small>
          This browser keeps owner access. Clearing its storage loses that
          access; there is no recovery flow.
        </small>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={pending} type="submit">
          {pending ? "Creating workspace…" : "Create workspace"}
        </button>
      </form>
      <Link className="back-link" to={`/demo/w/${sample.id}`}>
        Explore the sample workspace →
      </Link>
    </main>
  );
}

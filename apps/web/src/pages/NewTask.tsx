import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DraftFile, Material } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { inputOptionsFrom } from "../task-inputs";
import {
  RequirementForm,
  type TaskFields,
} from "../components/RequirementForm";
import { BackLink, PageHeading } from "../components/PageHeading";

/**
 * Post a task (design §2.1).
 *
 * "The primary form action is Post task. It creates a posted task and opens its
 * discussion. It makes no Gemini request and creates no agent execution." The
 * form says so, because the whole point of the posted state is that a team can
 * argue about the requirements before spending anything.
 *
 * The submit lock follows A02's pitfall: it stays locked after a success until
 * navigation unmounts the route, and only unlocks on failure so an explicit
 * retry remains available. Clearing it in `finally` let a double-click post
 * twice in the gap between the response arriving and the route changing.
 */
export function NewTask({ workspaceId }: { workspaceId: string }) {
  const { api, session } = useBrowser();
  const navigate = useNavigate();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<
    import("@app/contracts").ApprovedFile[]
  >([]);
  const [inputError, setInputError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
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
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setInputError(
            "Inputs could not be loaded. Reload to select existing files, or attach them after posting.",
          );
        // A picker that cannot load its options is not a reason to block
        // posting: title and outcome are the required fields, and inputs can be
        // attached afterwards from the task itself.
      });
    return () => controller.abort();
  }, [api, workspaceId]);

  async function post(fields: TaskFields) {
    setPending(true);
    setFailure(null);
    try {
      const task = await api.postTask(workspaceId, {
        kind: "agent_task",
        ...fields,
        creatorGuestLabel: session.getGuest().name,
        clientRequestId: requestId.current,
      });
      // Stays locked; the route unmounts on navigate.
      navigate(`/w/${workspaceId}/tasks/${task.id}`);
    } catch (error) {
      setFailure(apiMessage(error));
      setPending(false);
    }
  }

  return (
    <>
      <BackLink to={`/w/${workspaceId}`}>All tasks</BackLink>
      <PageHeading
        eyebrow="From an idea to a shared task"
        title="What shall we work on?"
        description="Post the brief first. Nothing runs until someone starts it — decide that together."
      />
      <RequirementForm
        options={inputOptionsFrom(materials, drafts, approved)}
        optionsNote={inputError}
        guestLabel={session.getGuest().name}
        pending={pending}
        error={failure}
        onSubmit={(fields) => void post(fields)}
        onCancel={() => navigate(`/w/${workspaceId}`)}
      />
    </>
  );
}

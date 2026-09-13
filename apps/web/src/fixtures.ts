import {
  TASK_STATUSES,
  taskDetailSchema,
  taskSummarySchema,
  workspaceSchema,
  type PostTaskRequest,
  type TaskDetail,
  type TaskSummary,
} from "@app/contracts";

const timestamp = "2026-09-12T10:00:00Z";
export const workspace = workspaceSchema.parse({
  id: "10000000-0000-4000-8000-000000000001",
  name: "Launch room",
  purpose: "A thoughtful launch, built together.",
  guidance:
    "Keep the writing clear, make small changes, and review work together.",
  guidanceVersion: 1,
  status: "active",
  isOwner: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});

// Selection metadata is presentation-only; values are shared request input shapes.
export const inputOptions = [
  {
    label: "Launch brief.md",
    category: "Reference material",
    value: { materialId: "20000000-0000-4000-8000-000000000001" },
  },
  {
    label: "README.md",
    category: "Approved file",
    value: { approvedPath: "documents/README.md" },
  },
  {
    label: "Landing copy.md",
    category: "Shared draft",
    value: { draftFileId: "30000000-0000-4000-8000-000000000001" },
  },
] satisfies {
  label: string;
  category: string;
  value: PostTaskRequest["inputs"][number];
}[];

const titles = [
  "Write the launch announcement",
  "Plan the onboarding flow",
  "Build the getting-started guide",
  "Clarify the launch audience",
  "Review the landing page copy",
  "Give the launch checklist a final look",
  "Resolve the introduction edits",
  "Finish the accessibility checklist",
  "Resume the release notes",
  "Explore alternate taglines",
  "Document the project principles",
];

export const initialTasks: TaskDetail[] = TASK_STATUSES.map((status, index) =>
  taskDetailSchema.parse({
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspaceId: workspace.id,
    kind: "agent_task",
    title: titles[index],
    outcome:
      "Help a new contributor understand the project and take their first step with confidence.",
    criteria: [
      "Use clear, welcoming language.",
      "Include a practical next step.",
    ],
    version: 1,
    status,
    creatorGuestLabel: ["Guest Maple", "Guest River", "Guest Finch"][index % 3],
    manualSourcePath: null,
    outputPaths: ["documents/launch.md"],
    activeRunId: ["planning", "working", "needs_input"].includes(status)
      ? `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
      : null,
    discussionSeq: 0,
    inputs: [
      {
        id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        materialId: inputOptions[0]!.value.materialId,
        draftFileId: null,
        approvedPath: null,
        sourceVersion: null,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

export function summarize(task: TaskDetail): TaskSummary {
  return taskSummarySchema.parse({
    ...task,
    materialCount: task.inputs.filter((input) => input.materialId !== null)
      .length,
    openQuestionCount: task.status === "needs_input" ? 1 : 0,
  });
}

export function createFixtureTask(request: PostTaskRequest): TaskDetail {
  const now = new Date().toISOString();
  return taskDetailSchema.parse({
    ...request,
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    version: 1,
    status: "posted",
    activeRunId: null,
    discussionSeq: 0,
    manualSourcePath: null,
    createdAt: now,
    updatedAt: now,
    inputs: request.inputs.map((input) => ({
      id: crypto.randomUUID(),
      materialId: input.materialId ?? null,
      draftFileId: input.draftFileId ?? null,
      approvedPath: input.approvedPath ?? null,
      sourceVersion: input.sourceVersion ?? null,
    })),
  });
}

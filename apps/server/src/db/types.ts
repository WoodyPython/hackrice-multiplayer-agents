import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  ActorType,
  AgentPreset,
  AgentStatus,
  ApplyStatus,
  DraftStatus,
  ModelCallStatus,
  QuestionStatus,
  ReviewStatus,
  RunStatus,
  TaskKind,
  TaskStatus,
  WorkspaceStatus,
} from '@app/contracts';

/**
 * Hand-written Kysely schema mirroring db/migrations.
 *
 * Hand-written on purpose: the SQL files are the source of truth (Role B owns
 * db/migrations per section 15.1), and a codegen step would invite a second
 * schema definition that can drift. apps/server/test/schema.test.ts asserts the
 * live database matches, so drift fails a test rather than surfacing in prod.
 *
 * Column type conventions:
 *   Generated<T>              - has a database default; omit on insert
 *   ColumnType<S, I, U>       - distinct select / insert / update types
 *   timestamptz               - returned as Date by node-postgres
 *   bigint                    - returned as string by node-postgres (see below)
 *   jsonb                     - returned parsed
 *
 * bigint note: node-postgres returns int8 as a string to avoid precision loss.
 * db/client.ts overrides that parser for the columns we use (seq counters,
 * token counts) because none of them can approach 2^53. Types here reflect the
 * post-override reality: number.
 */

/**
 * Timestamp columns.
 *
 * Note the absence of a Generated<> wrapper. Generated<Timestamp> nests one
 * ColumnType inside another, and Selectable cannot unwrap that: a selected
 * created_at types as the raw ColumnType rather than Date, which breaks every
 * caller that tries to format it. The insert type here already includes
 * undefined, so the column is optional on insert and Generated<> buys nothing.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface WorkspacesTable {
  id: Generated<string>;
  name: string;
  purpose: Generated<string>;
  owner_key_hash: Buffer;
  guidance: Generated<string>;
  guidance_version: Generated<number>;
  status: Generated<WorkspaceStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TasksTable {
  id: Generated<string>;
  workspace_id: string;
  kind: TaskKind;
  manual_source_path: string | null;
  creator_guest_label: string;
  title: string;
  outcome: Generated<string>;
  criteria: Generated<string[]>;
  output_paths: Generated<string[]>;
  version: Generated<number>;
  status: Generated<TaskStatus>;
  active_run_id: string | null;
  discussion_seq: Generated<number>;
  client_request_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DiscussionEntriesTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  seq: number;
  actor_type: ActorType;
  guest_label: string | null;
  body: string;
  client_request_id: string | null;
  created_at: Timestamp;
}

export interface MaterialsTable {
  id: Generated<string>;
  workspace_id: string;
  filename: string;
  object_key: string;
  sha256: Buffer;
  byte_size: number;
  content_type: Generated<string>;
  guest_label: string | null;
  created_at: Timestamp;
  deleted_at: Timestamp | null;
}

export interface MaterialLinksTable {
  id: Generated<string>;
  workspace_id: string;
  material_id: string;
  task_id: string | null;
  discussion_entry_id: string | null;
  created_at: Timestamp;
}

export interface DraftFilesTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  path: string;
  epoch: Generated<number>;
  base_blob_sha: string | null;
  yjs_state: Buffer | null;
  state_vector: Buffer | null;
  persisted_revision: Generated<number>;
  status: Generated<DraftStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskInputLinksTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  material_id: string | null;
  draft_file_id: string | null;
  approved_path: string | null;
  source_version: string | null;
  created_at: Timestamp;
}

export interface DraftCheckpointsTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  commit_sha: string;
  document_revisions: Generated<Record<string, number>>;
  created_at: Timestamp;
}

export interface RunsTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  attempt: number;
  task_version: number;
  guidance_version: number;
  discussion_cutoff_seq: number;
  client_request_id: string | null;
  input_snapshot_sha: string | null;
  context_manifest: Record<string, unknown> | null;
  result_head_sha: string | null;
  boot_id: string;
  status: Generated<RunStatus>;
  created_at: Timestamp;
  ended_at: Timestamp | null;
}

export interface TaskAgentBudgetsTable {
  workspace_id: string;
  task_id: string;
  agent_key: string;
  token_budget: number;
  consumed_tokens: Generated<number>;
  reserved_tokens: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AgentInstancesTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  run_id: string;
  agent_key: string;
  assignment_key: string;
  preset: AgentPreset;
  model_id: string;
  status: Generated<AgentStatus>;
  instruction: Generated<string>;
  write_paths: Generated<string[]>;
  base_sha: string | null;
  result_sha: string | null;
  boot_id: string;
  started_at: Timestamp | null;
  deadline_at: Timestamp | null;
  ended_at: Timestamp | null;
  created_at: Timestamp;
}

export interface AgentDependenciesTable {
  run_id: string;
  agent_id: string;
  prerequisite_agent_id: string;
}

export interface AgentQuestionsTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  run_id: string;
  agent_instance_id: string;
  question_entry_id: string;
  answer_entry_id: string | null;
  status: Generated<QuestionStatus>;
  asked_at: Timestamp;
  expires_at: Timestamp;
  resolved_at: Timestamp | null;
}

export interface ModelCallsTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  agent_id: string;
  request_key: string;
  provider_request_id: string | null;
  model_id: string;
  reserved_tokens: Generated<number>;
  reported_usage: Record<string, unknown> | null;
  status: Generated<ModelCallStatus>;
  created_at: Timestamp;
  settled_at: Timestamp | null;
}

export interface TaskEventsTable {
  id: Generated<number>;
  workspace_id: string;
  task_id: string;
  run_id: string | null;
  event_key: string;
  type: string;
  payload: Generated<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface ReviewsTable {
  id: Generated<string>;
  workspace_id: string;
  task_id: string;
  run_id: string | null;
  task_version: number;
  guidance_version: number;
  main_sha: string;
  human_sha: string;
  result_sha: string | null;
  document_revisions: Generated<Record<string, number>>;
  context_hash: string;
  candidate_sha: string | null;
  status: Generated<ReviewStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApplyOperationsTable {
  id: Generated<string>;
  workspace_id: string;
  review_id: string;
  expected_main_sha: string;
  candidate_sha: string;
  status: Generated<ApplyStatus>;
  boot_id: string;
  error_code: string | null;
  created_at: Timestamp;
  settled_at: Timestamp | null;
}

export interface WorkspaceBriefingsTable {
  id: Generated<string>;
  workspace_id: string;
  viewer_hash: Buffer;
  window_mode: 'since_last' | 'last_hour' | 'last_24h';
  window_start: Timestamp;
  window_end: Timestamp;
  advances_cutoff: boolean;
  content: Record<string, unknown>;
  created_at: Timestamp;
}

export interface SchemaMigrationsTable {
  filename: string;
  checksum: string;
  applied_at: Timestamp;
}

export interface Database {
  workspaces: WorkspacesTable;
  tasks: TasksTable;
  discussion_entries: DiscussionEntriesTable;
  materials: MaterialsTable;
  material_links: MaterialLinksTable;
  draft_files: DraftFilesTable;
  task_input_links: TaskInputLinksTable;
  draft_checkpoints: DraftCheckpointsTable;
  runs: RunsTable;
  task_agent_budgets: TaskAgentBudgetsTable;
  agent_instances: AgentInstancesTable;
  agent_dependencies: AgentDependenciesTable;
  agent_questions: AgentQuestionsTable;
  model_calls: ModelCallsTable;
  task_events: TaskEventsTable;
  reviews: ReviewsTable;
  apply_operations: ApplyOperationsTable;
  workspace_briefings: WorkspaceBriefingsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Workspace = Selectable<WorkspacesTable>;
export type NewWorkspace = Insertable<WorkspacesTable>;
export type WorkspaceUpdate = Updateable<WorkspacesTable>;

export type TaskRow = Selectable<TasksTable>;
export type NewTask = Insertable<TasksTable>;
export type TaskUpdate = Updateable<TasksTable>;

export type DiscussionEntryRow = Selectable<DiscussionEntriesTable>;
export type NewDiscussionEntry = Insertable<DiscussionEntriesTable>;

export type RunRow = Selectable<RunsTable>;
export type NewRun = Insertable<RunsTable>;

export type AgentQuestionRow = Selectable<AgentQuestionsTable>;
export type MaterialRow = Selectable<MaterialsTable>;
export type AgentInstanceRow = Selectable<AgentInstancesTable>;
export type ReviewRow = Selectable<ReviewsTable>;
export type ApplyOperationRow = Selectable<ApplyOperationsTable>;
export type ModelCallRow = Selectable<ModelCallsTable>;
export type DraftFileRow = Selectable<DraftFilesTable>;
export type NewMaterial = Insertable<MaterialsTable>;
export type NewAgentQuestion = Insertable<AgentQuestionsTable>;

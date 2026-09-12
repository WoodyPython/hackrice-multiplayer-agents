import {
  ORCHESTRATOR_AGENT_KEY, isReadOnlyPreset, orchestratorPlanSchema, workspaceFilePathSchema,
  type AgentPlan, type PlanValidationError,
} from '@app/contracts';

export type PlanValidationResult =
  | { valid: true; plan: AgentPlan; order: string[] }
  | { valid: false; errors: PlanValidationError[] };

/** Syntax only. D02/C04 must still reject symlinks/special files and check the
 * resolved path, expected hash and live execution state at the mutation gate.
 */
export function isPermittedWritePath(path: string): boolean {
  const parsed = workspaceFilePathSchema.safeParse(path);
  return parsed.success && parsed.data === path;
}

/** No model output reaches storage or dispatch before this gate succeeds. */
export function validatePlan(value: unknown): PlanValidationResult {
  const parsed = orchestratorPlanSchema.safeParse(value);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((issue) => ({
    kind: issue.path.includes('preset') ? 'invalid_preset' : issue.path.includes('writePaths') ? 'invalid_path' : 'invalid_shape',
    assignmentIds: [], message: `${issue.path.join('.') || 'plan'}: ${issue.message}`,
  })) };
  const plan = parsed.data;
  const errors: PlanValidationError[] = [];
  const add = (kind: PlanValidationError['kind'], assignmentIds: string[], message: string) => {
    errors.push({ kind, assignmentIds, message });
  };
  if (!plan.summary.trim()) add('invalid_shape', [], 'Summary must not be blank.');
  const byId = new Map<string, AgentPlan['assignments'][number]>();
  for (const assignment of plan.assignments) {
    if (byId.has(assignment.id)) add('duplicate_assignment_id', [assignment.id], 'Assignment IDs must be unique.');
    byId.set(assignment.id, assignment);
    if (assignment.id === ORCHESTRATOR_AGENT_KEY) {
      add('reserved_assignment_id', [assignment.id], 'The orchestrator key is reserved for planning.');
    }
    if (!assignment.instruction.trim()) add('invalid_shape', [assignment.id], 'Instruction must not be blank.');
    if (isReadOnlyPreset(assignment.preset) && assignment.writePaths.length) {
      add(assignment.preset === 'reviewer' ? 'reviewer_write_scope' : 'analyst_write_scope',
        [assignment.id], `${assignment.preset} assignments must be read-only.`);
    }
    for (const path of assignment.writePaths) {
      if (!isPermittedWritePath(path)) add('invalid_path', [assignment.id], `Not a permitted exact file path: ${path}`);
    }
    if (new Set(assignment.dependsOn).size !== assignment.dependsOn.length) {
      add('duplicate_dependency', [assignment.id], 'A dependency may only be listed once.');
    }
  }
  for (const assignment of plan.assignments) {
    for (const dependency of assignment.dependsOn) {
      if (!byId.has(dependency)) add('unknown_dependency', [assignment.id], `Unknown dependency: ${dependency}`);
    }
  }
  if (errors.length) return { valid: false, errors };

  // Iterative Kahn traversal avoids a recursive stack limit on long plans.
  const outstanding = new Map(plan.assignments.map((a) => [a.id, a.dependsOn.length]));
  const children = new Map(plan.assignments.map((a) => [a.id, [] as string[]]));
  for (const a of plan.assignments) for (const parent of a.dependsOn) children.get(parent)!.push(a.id);
  const order = plan.assignments.filter((a) => !a.dependsOn.length).map((a) => a.id);
  for (let cursor = 0; cursor < order.length; cursor++) {
    for (const child of children.get(order[cursor]!)!) {
      const count = outstanding.get(child)! - 1;
      outstanding.set(child, count);
      if (count === 0) order.push(child);
    }
  }
  if (order.length !== plan.assignments.length) {
    return { valid: false, errors: [{ kind: 'cycle',
      assignmentIds: plan.assignments.filter((a) => outstanding.get(a.id)! > 0).map((a) => a.id),
      message: 'Dependency graph contains a cycle; listed assignments are cyclic or blocked by it.',
    }] };
  }

  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const reachable = new Set<string>();
    for (const parent of byId.get(id)!.dependsOn) {
      reachable.add(parent);
      for (const ancestor of ancestors.get(parent)!) reachable.add(ancestor);
    }
    ancestors.set(id, reachable);
  }
  const writes = plan.assignments.flatMap((a) => a.writePaths.map((path) => ({ id: a.id, path, key: path.toLowerCase() })));
  const spellings = new Map<string, { path: string; id: string }>();
  for (const write of writes) {
    const parts = write.path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const prior = spellings.get(prefix.toLowerCase());
      if (prior && prior.path !== prefix) {
        add('path_collision', [prior.id, write.id], `Case aliases at the same path depth: ${prior.path} and ${prefix}`);
      }
      spellings.set(prefix.toLowerCase(), { path: prefix, id: write.id });
    }
  }
  for (let i = 0; i < writes.length; i++) {
    const a = writes[i]!;
    for (let j = i + 1; j < writes.length; j++) {
      const b = writes[j]!;
      // A declared path is a file, never a directory scope or a glob. A file
      // and its descendant cannot both exist, even with ordered writers.
      if (a.key.startsWith(`${b.key}/`) || b.key.startsWith(`${a.key}/`) ||
          (a.key === b.key && a.path !== b.path) || (a.key === b.key && a.id === b.id)) {
        add('path_collision', [a.id, b.id], `Incompatible file paths: ${a.path} and ${b.path}`);
      } else if (a.key === b.key && !ancestors.get(a.id)!.has(b.id) && !ancestors.get(b.id)!.has(a.id)) {
        add('unordered_write_overlap', [a.id, b.id], `Writers of ${a.path} need a direct or transitive dependency.`);
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, plan, order };
}

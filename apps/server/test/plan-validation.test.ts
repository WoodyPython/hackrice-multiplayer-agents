import { describe, expect, it } from 'vitest';
import { agentPlanSchema, type AgentPlan } from '@app/contracts';
import { isPermittedWritePath, validatePlan, PLAN_RESPONSE_SCHEMA } from '../src/orchestration/index.js';
import { filePath, portablePaths } from '../src/git/files.js';

function assignment(id: string, dependsOn: string[] = [], writePaths: string[] = [], preset: 'writer' | 'coder' | 'analyst' | 'reviewer' = 'writer') {
  return { id, dependsOn, writePaths, preset, instruction: `Perform ${id} and return evidence.` };
}
const plan = (assignments = [assignment('a')]) => ({ summary: 'Do the task.', assignments });
function kinds(value: unknown) {
  const checked = validatePlan(value);
  if (checked.valid) throw new Error('Expected rejection');
  return checked.errors.map((e) => e.kind);
}

describe('assignment graph validation', () => {
  it('accepts a branching graph with a reviewer joining independent writers', () => {
    const value = plan([assignment('facts', [], [], 'analyst'),
      assignment('faq', ['facts'], ['documents/faq.md']), assignment('code', ['facts'], ['code/index.ts'], 'coder'),
      assignment('review', ['faq', 'code'], [], 'reviewer')]);
    expect(validatePlan(value)).toEqual({ valid: true, plan: value, order: ['facts', 'faq', 'code', 'review'] });
  });
  it('accepts same-file writers ordered in either direction or transitively', () => {
    for (const items of [
      [assignment('a', [], ['documents/faq.md']), assignment('b', ['a'], ['documents/faq.md'])],
      [assignment('b', ['a'], ['documents/faq.md']), assignment('a', [], ['documents/faq.md'])],
      [assignment('a', [], ['documents/faq.md']), assignment('bridge', ['a']), assignment('b', ['bridge'], ['documents/faq.md'])],
    ]) expect(validatePlan(plan(items)).valid).toBe(true);
  });
  it('rejects shared-file writers that only share a prerequisite', () => {
    expect(kinds(plan([assignment('facts'), assignment('a', ['facts'], ['documents/faq.md']),
      assignment('b', ['facts'], ['documents/faq.md'])]))).toContain('unordered_write_overlap');
  });
  it.each([
    [assignment('a', ['a'])],
    [assignment('a', ['b']), assignment('b', ['a'])],
    [assignment('free'), assignment('a', ['b']), assignment('b', ['a']), assignment('blocked', ['a'])],
  ])('rejects cyclic graphs', (...assignments) => { expect(kinds(plan(assignments))).toContain('cycle'); });
  it('rejects unknown or repeated dependencies and duplicate or reserved IDs', () => {
    expect(kinds(plan([assignment('a', ['missing'])]))).toContain('unknown_dependency');
    expect(kinds(plan([assignment('a'), assignment('b', ['a', 'a'])]))).toContain('duplicate_dependency');
    expect(kinds(plan([assignment('a'), assignment(' a ')]))).toContain('duplicate_assignment_id');
    expect(kinds(plan([assignment('orchestrator')]))).toContain('reserved_assignment_id');
  });
  it.each(['analyst', 'reviewer'] as const)('rejects writes by read-only %s', (preset) => {
    expect(kinds(plan([assignment('a', [], ['documents/x.md'], preset)]))).toContain(`${preset}_write_scope`);
  });
  it('rejects orchestrator/unknown presets and malformed or misspelled fields', () => {
    for (const preset of ['orchestrator', 'root', '', null]) {
      expect(kinds({ ...plan(), assignments: [{ ...assignment('a'), preset }] })).toContain('invalid_preset');
    }
    for (const value of [null, [], {}, plan([]), { ...plan(), shell: 'x' },
      { ...plan(), assignments: [{ id: 'x', preset: 'writer', depends_on: [], write_paths: [], instruction: 'x' }] },
      { ...plan(), assignments: [{ ...assignment('a'), instruction: '  ' }] }, { ...plan(), summary: '  ' }]) {
      expect(kinds(value)).toContain('invalid_shape');
    }
  });
  it('supports more than 64 assignments and more than 50 dependencies', () => {
    const items = Array.from({ length: 100 }, (_, i) => assignment(`a${i}`));
    items.push(assignment('join', items.map((a) => a.id), [], 'reviewer'));
    expect(agentPlanSchema.safeParse(plan(items)).success).toBe(true);
    expect(validatePlan(plan(items)).valid).toBe(true);
    expect(PLAN_RESPONSE_SCHEMA.properties.assignments).not.toHaveProperty('maxItems');
  });
  it('handles long chains without recursive traversal and does not mutate input', () => {
    const value = plan(Array.from({ length: 1000 }, (_, i) => assignment(`a${i}`, i ? [`a${i - 1}`] : [])));
    const before = structuredClone(value);
    expect(validatePlan(value).valid).toBe(true);
    expect(value).toEqual(before);
  });
  it('uses maps safely for JavaScript property-like IDs', () => {
    expect(validatePlan(plan([assignment('__proto__'), assignment('constructor', ['__proto__'])])).valid).toBe(true);
  });
});

describe('exact writable path validation', () => {
  it.each(['documents/faq.md', 'code/src/index.ts', 'documents/日本語.md', 'documents/team notes.md'])('accepts %s', (path) => {
    expect(isPermittedWritePath(path)).toBe(true);
    expect(filePath(path)).toBe(path);
  });
  it.each(['/tmp/x', 'C:/x', '\\server\\x', '../documents/x', 'documents/../x', 'documents/./x',
    'documents//x', 'documents/', 'documents', 'code', 'logs/work.md', '.git/config',
    'documents/.GIT/config', 'code/.gitattributes', 'code/.gitmodules', 'code/x\0y',
    'documents\\x.md', 'documents/*.md', 'documents/x?.md', 'documents/x:y',
    'documents/ x.md', 'documents/x.md ', 'documents/x.', 'documents/NUL.txt', 'code/COM1',
    'documents/x\ny', 'documents/cafe\u0301.md', 'documents/a.png', 'code/hooks/index.ts',
    'code/DIR~1/index.ts'])('rejects %j', (path) => {
    expect(isPermittedWritePath(path)).toBe(false);
    expect(kinds(plan([assignment('a', [], [path])]))).toContain('invalid_path');
  });
  it('rejects duplicate paths, case aliases and file/directory collisions even if ordered', () => {
    expect(kinds(plan([assignment('a', [], ['documents/a.md', 'documents/a.md'])]))).toContain('path_collision');
    for (const paths of [['documents/A.md', 'documents/a.md'], ['code/src.ts', 'code/src.ts/index.ts'],
      ['code/Folder/a.ts', 'code/folder/b.ts']]) {
      expect(kinds(plan([assignment('a', [], [paths[0]!]), assignment('b', ['a'], [paths[1]!])]))).toContain('path_collision');
      expect(() => portablePaths(paths)).toThrow();
    }
  });
  it('does not confuse file-prefix siblings with overlapping scopes', () => {
    const value: AgentPlan = plan([assignment('a', [], ['documents/a.md']), assignment('b', [], ['documents/a.md.txt'])]);
    expect(validatePlan(value).valid).toBe(true);
  });
});

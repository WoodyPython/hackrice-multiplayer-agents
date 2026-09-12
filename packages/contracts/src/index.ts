/**
 * @app/contracts — the shared source of truth for every role.
 *
 * Owned by Role B (design section 15.1), consumed by A, C, and D.
 *
 * RULE: this package is additive-only until integration. Add fields, add
 * schemas, add codes. Do not rename or remove anything another role may already
 * be importing — a rename here breaks three branches at once.
 *
 * Anything that mirrors the database (enums, status sets) must be changed in
 * the same commit as db/migrations, or the two will drift silently.
 */

export * from './ids.js';
export * from './paths.js';
export * from './enums.js';
export * from './errors.js';
export * from './workspace.js';
export * from './task.js';
export * from './discussion.js';
export * from './material.js';
export * from './draft.js';
export * from './run.js';
export * from './review.js';
export * from './events.js';
export * from './services.js';
export * from './git.js';
export * from './collaboration.js';
export * from './worker.js';
export * from './scheduler.js';
export * from './retry.js';

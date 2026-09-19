/**
 * workflow — duya 原生 Workflow RPA×Agent 融合引擎 (plans 415 + 552).
 *
 * An independent background run-management system (NOT a mode): YAML
 * definitions, six node kinds (tool / gui / decision / human / agent /
 * noop), map + when primitives, journal-driven breakpoint resume, and
 * a run-level lifecycle state machine sharing vocabulary with goal via
 * the small kernel in `engine/run-lifecycle-tracker.ts`.
 */

export * from './schema.js';
export * from './expr.js';
export * from './validate.js';
export * from './tracker.js';

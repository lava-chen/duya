/**
 * @duya/conductor
 *
 * Shared Conductor canvas contracts. Agent execution is owned by the main
 * `@duya/agent` runtime through its declarative conductor mode; this package
 * owns renderer, database, and canvas-domain code only.
 *
 * Naming: "conductor" here means the conductor's stage, not the conductor
 * itself. The orchestrating agent tools live in
 * `packages/agent/src/tool/CanvasConductor` — do not import them from here.
 * A rename of this package to "canvas" was evaluated and rejected: it would
 * cost ~344 files across 2 databases, 230 i18n keys and 39 CSS tokens, while
 * collapsing the distinction between the agent that conducts and the surface
 * it conducts on. See `docs/architecture/09-conductor-rename-assessment.md`.
 */

export type {
  DatabaseFilterNode,
  DatabaseProperty,
  DatabasePropertyOption,
  DatabasePropertyType,
  DatabaseQueryResult,
  DatabaseRecord,
  DatabaseRecordSnapshot,
  DatabaseSortRule,
  DatabaseSource,
  DatabaseSourceSnapshot,
  DatabaseValue,
  DatabaseView,
  NativeDatabaseElementConfig,
  ProjectDatabaseChangeEvent,
  ProjectDatabaseCommand,
  ProjectDatabaseRequest,
} from './database/types.js';
export {
  DATABASE_PROPERTY_TYPES,
  DatabaseFilterNodeSchema,
  DatabaseSortRuleSchema,
  DatabaseValueSchema,
  ProjectDatabaseCommandSchema,
  ProjectDatabaseRequestSchema,
} from './database/types.js';

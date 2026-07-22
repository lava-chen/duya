/**
 * @duya/conductor
 *
 * Canvas orchestrator agent subsystem. Owns:
 * - Conductor profile + prompt system
 * - Canvas orchestrator tool definitions and executors
 * - Canvas state snapshot (set/get) used to compose the conductor system prompt
 * - Perception engine that flushes UI events back as context
 * - Runtime registration: `registerConductor({ ... })` wires conductor into the
 *   host `@duya/agent` process
 *
 * Public API is intentionally narrow — host code should not reach into
 * conductor internals. All integration happens through the registration
 * function exported from this module.
 */

export type { ConductorSnapshot } from '@duya/agent/conductor/profile';
export type { ConductorCanvasSnapshot } from './prompt/canvasSection.js';
export type { ConductorIpcBridge, ConductorIpcRequest, ConductorIpcResponse } from './ipc.js';

export {
  setConductorCanvasState,
  getConductorCanvasSnapshot,
  buildConductorCanvasSection,
} from './prompt/canvasSection.js';
export { CANVAS_ORCHESTRATOR_TOOLS, getCanvasOrchestratorExecutors } from './tool/CanvasOrchestratorProfile.js';
export { VIZ_SPEC_PROMPT, VIZ_SPEC_WORKED_EXAMPLES } from './prompt/vizSpec.js';
export { ConductorPromptSystem } from './prompt/ConductorPromptSystem.js';
export { CONDUCTOR_PROMPT_PROFILE } from './prompt/conductor-prompt.js';
export {
  PerceptionEngine,
  getPerceptionEngine,
  resetPerceptionEngine,
} from './runtime/PerceptionEngine.js';
export type { SemanticEvent, SemanticEventType, PerceptionConfig } from './runtime/PerceptionEngine.js';
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

export {
  registerConductor,
  type ConductorRegistration,
  type ConductorRegistrationHandle,
  type ConductorPromptRegistry,
  type ConductorToolRegistry,
} from './register.js';

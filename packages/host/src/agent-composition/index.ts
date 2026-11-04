/**
 * Plan 624 — agent composition layer.
 *
 * The single policy point between the control layer (session / bot / TUI /
 * coordinator / desktop / gateway) and the zero-policy execution layer.
 *
 * Slice A1 scope: contract types plus the two IO-free resolvers (scope and
 * prompt selection). Shadow comparison against the live assembly lands in A2;
 * nothing here is wired into `beginTurnAssembly` yet, so behaviour is unchanged.
 */
export type {
  AgentCompositionRequest,
  CompositionDecision,
  CompositionScope,
  CompositionSource,
  PromptSelection,
  ScopeResolution,
} from './contract.js';
export { resolveCompositionScope } from './scope.js';
export { resolvePromptSelection } from './prompt-selection.js';

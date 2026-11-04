/**
 * Plan 624 — agent composition layer.
 *
 * The single policy point between the control layer (session / bot / TUI /
 * coordinator / desktop / gateway) and the zero-policy execution layer.
 *
 * Slice A1 scope: contract types plus the IO-free resolvers. Shadow comparison
 * against the live assembly lands in A2; nothing here is wired into
 * `beginTurnAssembly` yet, so behaviour is unchanged.
 */
export type {
  AgentCompositionRequest,
  CacheSelection,
  CacheSelectionInput,
  CompositionDecision,
  CompositionScope,
  CompositionSource,
  ModeSelection,
  ModeSelectionInput,
  PermissionSelection,
  PermissionSelectionInput,
  PromptSelection,
  ProviderCacheFamily,
  ScopeResolution,
  ToolSelection,
  ToolSelectionInput,
} from './contract.js';
export { resolveCompositionScope } from './scope.js';
export { resolvePromptSelection } from './prompt-selection.js';
export { resolveToolSelection } from './tools-selection.js';
export { resolveModeSelection, type ModeModifierLookup } from './modes-selection.js';
export { resolvePermissionSelection, DEFAULT_PERMISSION_MODE } from './permissions-selection.js';
export {
  resolveCacheSelection,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  ANTHROPIC_CACHE_BREAKPOINTS,
} from './cache-selection.js';

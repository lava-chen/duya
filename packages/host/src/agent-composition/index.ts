/**
 * Plan 624 v2 — agent composition layer.
 *
 * The single policy point between the control layer (session / bot / TUI /
 * coordinator / desktop / gateway) and the zero-policy execution layer.
 *
 * `composeAgent()` produces ONE frozen `AgentComposition` per run. Every
 * downstream phase consumes that plan; none of them re-decides a dimension.
 * `composeStartup()` does the same for the two session-level facts decided
 * before a profile exists (provider cache family, initial permission mode).
 */
export type {
  AgentComposition,
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
  StartupComposition,
  ToolSelection,
  ToolSelectionInput,
  TurnOverrides,
} from './contract.js';
export {
  composeAgent,
  composeStartup,
  readTurnOverrides,
  type CompositionInput,
  type StartupCompositionInput,
  type TurnOverrideInput,
} from './compose.js';
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
export {
  resolveTimeReminder,
  inferTimeReminderTurnKind,
  DEFAULT_TIME_REMINDER_INTERVAL_SECONDS,
  DEFAULT_TIME_REMINDER_DELIVERY_MODE,
  TIME_REMINDER_BLOCK_ID,
  type TimeReminderBlockSelection,
  type TimeReminderSelection,
  type TimeReminderSelectionInput,
} from './reminder-selection.js';
export {
  decideTimeReminder,
  renderTimeReminder,
  renderTimeUnavailable,
  type TimeReminderDecision,
  type TimeReminderDeliveryMode,
  type TimeReminderEmissionState,
  type TimeReminderReason,
  type TimeReminderRequest,
  type TimeReminderTurnKind,
} from './time-reminder.js';

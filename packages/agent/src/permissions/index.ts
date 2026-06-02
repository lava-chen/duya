/**
 * Permissions Module - Public API
 */

// Types
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionDecision,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionResult,
  PermissionDecisionReason,
  ToolPermissionContext,
  YoloClassifierResult,
  ClassifierUsage,
  ClassifierResult,
  ClassifierBehavior,
} from './types.js'

export {
  EXTERNAL_PERMISSION_MODES,
  INTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
} from './types.js'

// Permission Mode Logic
export {
  permissionModeFromString,
  permissionModeTitle,
  permissionModeShortTitle,
  isDefaultMode,
  isExternalPermissionMode,
  toExternalPermissionMode,
  getModeColor,
  permissionModeSymbol,
  isBypassMode,
} from './PermissionMode.js'

// Rule Parser
export {
  permissionRuleValueFromString,
  permissionRuleValueToString,
  normalizeLegacyToolName,
  getLegacyToolNames,
  escapeRuleContent,
  unescapeRuleContent,
} from './permissionRuleParser.js'

// Permission Result
export { getRuleBehaviorDescription } from './PermissionResult.js'

// Main Permissions
export {
  getAllowRules,
  getDenyRules,
  getAskRules,
  createHasPermissionsToUseTool,
} from './permissions.js'
export type {
  HasPermissionsFn,
  ToolPermissionCheckContext,
} from './permissions.js'

// Bash Classifier
export {
  PROMPT_PREFIX,
  extractPromptDescription,
  createPromptRuleContent,
  isClassifierPermissionsEnabled,
  getBashPromptDenyDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptAllowDescriptions,
  classifyBashCommand,
  generateGenericDescription,
} from './bashClassifier.js'
export type { ClassifierResult as BashClassifierResult, ClassifierBehavior as BashClassifierBehavior } from './bashClassifier.js'

// Classifier Decision
export {
  isAutoModeAllowlistedTool,
} from './classifierDecision.js'

// YOLO Classifier
export {
  classifyAction,
  buildTranscriptEntries,
  buildYoloSystemPrompt,
  formatActionForClassifier,
} from './yoloClassifier.js'
export type {
  YoloClassifierOptions,
} from './yoloClassifier.js'

// Auto Mode State
export {
  setAutoModeActive,
  isAutoModeActive,
  setAutoModeCircuitBroken,
  isAutoModeCircuitBroken,
} from './autoModeState.js'

// Auto Mode Denials
export {
  recordAutoModeDenial,
  getAutoModeDenials,
} from './autoModeDenials.js'
export type { AutoModeDenial } from './autoModeDenials.js'

// Denial Tracking
export {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from './denialTracking.js'
export type { DenialTrackingState } from './denialTracking.js'

// Path Permission
export {
  checkPathReadPermission,
  checkPathWritePermission,
} from './pathPermission.js'

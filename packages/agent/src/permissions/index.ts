/**
 * Permissions System for duya Agent
 *
 * This module provides permission checking and management for tool execution.
 * It supports multiple permission modes and rule-based permission configuration.
 */

// Types
export type {
  PermissionBehavior,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionMode,
  ExternalPermissionMode,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
  PermissionUpdate,
  PermissionUpdateDestination,
  AdditionalWorkingDirectory,
  YoloClassifierResult,
  RiskLevel,
  PermissionExplanation,
} from './types.js'

// Permission Mode
export {
  PERMISSION_MODES,
  EXTERNAL_PERMISSION_MODES,
  permissionModeTitle,
  permissionModeShortTitle,
  permissionModeFromString,
  isDefaultMode,
  isExternalPermissionMode,
  toExternalPermissionMode,
  getModeColor,
  permissionModeSymbol,
  isBypassMode,
} from './PermissionMode.js'

// Permission Rule
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

// Permissions Core
export {
  createHasPermissionsToUseTool,
  getAllowRules,
  getDenyRules,
  getAskRules,
  toolAlwaysAllowedRule,
  getDenyRuleForTool,
  getAskRuleForTool,
  getRuleByContentsForToolName,
  permissionRuleSourceDisplayString,
} from './permissions.js'

export type { HasPermissionsFn, ToolPermissionCheckContext } from './permissions.js'

// Permissions Loader
export {
  loadAllPermissionRulesFromDisk,
  getPermissionRulesForSource,
  deletePermissionRuleFromSettings,
  addPermissionRulesToSettings,
  settingsJsonToRules,
  type PermissionsJson,
} from './permissionsLoader.js'

// Classifier
export {
  isAutoModeAllowlistedTool,
} from './classifierDecision.js'

export {
  isClassifierPermissionsEnabled,
  classifyBashCommand,
  getBashPromptDenyDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptAllowDescriptions,
  createPromptRuleContent,
  extractPromptDescription,
  generateGenericDescription,
} from './bashClassifier.js'

export type { ClassifierResult as BashClassifierResult, ClassifierBehavior } from './bashClassifier.js'

// Denial Tracking
export {
  DENIAL_LIMITS,
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
  type DenialTrackingState,
} from './denialTracking.js'

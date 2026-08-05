/**
 * Permission rules domain: parsing, serialization, and loading.
 *
 * Merges the former permissionRuleParser, permissionsLoader, and the
 * empty PermissionRule/PermissionResult re-export shells into one module.
 * All rule-string <-> PermissionRuleValue conversions and settings-JSON
 * loading live here. Type-only re-exports are kept for backward
 * compatibility with callers that imported them from the old shells.
 */

import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './types.js'

// ============================================================================
// Rule String Parsing
// ============================================================================

// Maps legacy tool names to their current canonical names.
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: 'Agent',
  KillShell: 'Task', // Unified task tool with action "stop"
  TaskStop: 'Task', // Legacy TaskStop -> unified Task tool
  TaskCreate: 'Task', // Legacy TaskCreate -> unified Task tool
  TaskGet: 'Task', // Legacy TaskGet -> unified Task tool
  TaskList: 'Task', // Legacy TaskList -> unified Task tool
  TaskUpdate: 'Task', // Legacy TaskUpdate -> unified Task tool
  TaskOutput: 'Task', // Legacy TaskOutput -> unified Task tool
}

export function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

export function getLegacyToolNames(canonicalName: string): string[] {
  const result: string[] = []
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === canonicalName) result.push(legacy)
  }
  return result
}

/**
 * Escapes special characters in rule content for safe storage in permission rules.
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

/**
 * Unescapes special characters in rule content after parsing from permission rules.
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

/**
 * Parses a permission rule string into its components.
 * Format: "ToolName" or "ToolName(content)"
 */
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  if (closeParenIndex !== ruleString.length - 1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

  if (!toolName) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }

  const ruleContent = unescapeRuleContent(rawContent)
  return { toolName: normalizeLegacyToolName(toolName), ruleContent }
}

/**
 * Converts a permission rule value to its string representation.
 */
export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName
  }
  const escapedContent = escapeRuleContent(ruleValue.ruleContent)
  return `${ruleValue.toolName}(${escapedContent})`
}

function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}

function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}

// ============================================================================
// Rule Loading (settings JSON -> PermissionRule[])
// ============================================================================

const SUPPORTED_RULE_BEHAVIORS = [
  'allow',
  'deny',
  'ask',
] as const satisfies PermissionBehavior[]

/**
 * Converts permissions data to an array of PermissionRule objects
 */
export function settingsJsonToRules(
  data: PermissionsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!data || !data.permissions) {
    return []
  }

  const { permissions } = data
  const rules: PermissionRule[] = []
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior]
    if (behaviorArray) {
      for (const ruleString of behaviorArray) {
        rules.push({
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        })
      }
    }
  }
  return rules
}

/**
 * Loads all permission rules from all relevant sources
 */
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  // For duya, we use an in-memory store since there's no settings file
  // Override this method if you need to load from persistent storage
  return []
}

/**
 * Loads permission rules from a specific source
 */
export function getPermissionRulesForSource(
  _source: string,
): PermissionRule[] {
  // For duya, rules are managed in-memory
  return []
}

/**
 * Deletes a rule from settings
 */
export function deletePermissionRuleFromSettings(
  _rule: PermissionRule & { source: string },
): boolean {
  // For duya, rules are managed in-memory
  return false
}

/**
 * Adds rules to settings
 */
export function addPermissionRulesToSettings(
  _ruleValues: PermissionRuleValue[],
  _ruleBehavior: PermissionBehavior,
  _source: string,
): boolean {
  // For duya, rules are managed in-memory
  return false
}

export type PermissionsJson = {
  permissions?: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
    additionalDirectories?: string[]
  }
  defaultMode?: string
}

// ============================================================================
// Backward-compatible type re-exports (former PermissionRule/PermissionResult shells)
// ============================================================================

export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
}

/**
 * Get the appropriate prose description for rule behavior.
 */
export function getRuleBehaviorDescription(
  permissionResult: 'allow' | 'deny' | 'ask' | 'passthrough',
): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
/**
 * Permissions Loader for duya Agent
 * Adapted from claude-code-haha/src/utils/permissions/permissionsLoader.ts
 */

import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './types.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

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

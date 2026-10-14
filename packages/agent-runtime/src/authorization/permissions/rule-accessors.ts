import type { ToolPermissionContext, PermissionRule } from './types.js';
import { permissionRuleValueFromString } from './rules.js';
const PERMISSION_RULE_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
] as const

export function permissionRuleSourceDisplayString(
  source: string,
): string {
  return source
}

export function getAllowRules(
  context: ToolPermissionContext,
): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context.alwaysAllowRules[source] || []).map(ruleString => ({
      source: source as PermissionRule['source'],
      ruleBehavior: 'allow' as const,
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context.alwaysDenyRules[source] || []).map(ruleString => ({
      source: source as PermissionRule['source'],
      ruleBehavior: 'deny' as const,
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context.alwaysAskRules[source] || []).map(ruleString => ({
      source: source as PermissionRule['source'],
      ruleBehavior: 'ask' as const,
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

/**
 * Main Permissions System for duya Agent
 * Adapted from claude-code-haha/src/utils/permissions/permissions.ts
 */

import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
  PermissionRule,
  ToolPermissionContext,
} from './types.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
  type DenialTrackingState,
} from './denialTracking.js'

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

function toolMatchesRule(
  toolName: string,
  rule: PermissionRule,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }
  return rule.ruleValue.toolName === toolName
}

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  toolName: string,
): PermissionRule | null {
  return (
    getAllowRules(context).find(rule => toolMatchesRule(toolName, rule)) || null
  )
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  toolName: string,
): PermissionRule | null {
  return getDenyRules(context).find(rule => toolMatchesRule(toolName, rule)) || null
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  toolName: string,
): PermissionRule | null {
  return getAskRules(context).find(rule => toolMatchesRule(toolName, rule)) || null
}

export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: 'allow' | 'deny' | 'ask',
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  let rules: PermissionRule[] = []
  switch (behavior) {
    case 'allow':
      rules = getAllowRules(context)
      break
    case 'deny':
      rules = getDenyRules(context)
      break
    case 'ask':
      rules = getAskRules(context)
      break
  }
  for (const rule of rules) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}

function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (decisionReason) {
    switch (decisionReason.type) {
      case 'rule': {
        const ruleString = permissionRuleValueToString(
          decisionReason.rule.ruleValue,
        )
        const sourceString = permissionRuleSourceDisplayString(
          decisionReason.rule.source,
        )
        return `Permission rule '${ruleString}' from ${sourceString} requires approval for this ${toolName} command`
      }
      case 'mode': {
        return `Current permission mode (${decisionReason.mode}) requires approval for this ${toolName} command`
      }
      case 'workingDir':
        return decisionReason.reason
      case 'safetyCheck':
      case 'other':
        return decisionReason.reason
    }
  }
  return `Claude requested permissions to use ${toolName}, but you haven't granted it yet.`
}

const AUTO_REJECT_MESSAGE = (toolName: string) =>
  `Permission to use ${toolName} was denied. Permission prompts are not available in this context.`

export interface ToolPermissionCheckContext {
  getAppState: () => {
    toolPermissionContext: ToolPermissionContext
    denialTracking?: DenialTrackingState
  }
  setAppState?: (fn: (prev: unknown) => { denialTracking?: DenialTrackingState }) => void
  localDenialTracking?: DenialTrackingState
  abortController: AbortController
}

export type HasPermissionsFn = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionCheckContext,
) => Promise<PermissionDecision>

/**
 * Creates the main permission check function
 */
export function createHasPermissionsToUseTool(): HasPermissionsFn {
  return async function hasPermissionsToUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolPermissionCheckContext,
  ): Promise<PermissionDecision> {
    if (context.abortController.signal.aborted) {
      throw new Error('Aborted')
    }

    let appState = context.getAppState()

    // 1. Check if the tool is denied
    const denyRule = getDenyRuleForTool(appState.toolPermissionContext, toolName)
    if (denyRule) {
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
        message: `Permission to use ${toolName} has been denied.`,
      }
    }

    // 2. Check if the entire tool should always ask for permission
    const askRule = getAskRuleForTool(appState.toolPermissionContext, toolName)
    if (askRule) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(toolName),
      }
    }

    // 3. Check mode-based permissions
    const shouldBypassPermissions =
      appState.toolPermissionContext.mode === 'bypassPermissions' ||
      (appState.toolPermissionContext.mode === 'plan' &&
        appState.toolPermissionContext.isBypassPermissionsModeAvailable)

    if (shouldBypassPermissions) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'mode',
          mode: appState.toolPermissionContext.mode,
        },
      }
    }

    // 4. Check if entire tool is allowed
    const alwaysAllowedRule = toolAlwaysAllowedRule(
      appState.toolPermissionContext,
      toolName,
    )
    if (alwaysAllowedRule) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'rule',
          rule: alwaysAllowedRule,
        },
      }
    }

    // Default: ask for permission
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(toolName),
    }
  }
}

/**
 * Persist denial tracking state
 */
function persistDenialState(
  context: ToolPermissionCheckContext,
  newState: DenialTrackingState,
): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, newState)
  } else if (context.setAppState) {
    context.setAppState((prev): { denialTracking?: DenialTrackingState } => {
      if (!prev || typeof prev !== 'object') return { denialTracking: newState }
      const prevState = prev as { denialTracking?: DenialTrackingState }
      if (prevState.denialTracking === newState) return prevState
      return { ...prevState, denialTracking: newState }
    })
  }
}

/**
 * Check if a denial limit was exceeded
 */
function handleDenialLimitExceeded(
  denialState: DenialTrackingState,
  toolName: string,
  classifierReason: string,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  const warning = hitTotalLimit
    ? `${denialState.totalDenials} actions were blocked this session.`
    : `${denialState.consecutiveDenials} consecutive actions were blocked.`

  return {
    behavior: 'deny',
    decisionReason: {
      type: 'classifier',
      classifier: 'auto-mode',
      reason: `${warning}\n\nLatest blocked action: ${classifierReason}`,
    },
    message: `Permission to use ${toolName} was denied.`,
  }
}

export {
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  type DenialTrackingState,
}

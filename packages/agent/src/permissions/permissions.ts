/**
 * Main Permissions System for duya Agent
 * Adapted from claude-code-haha/src/utils/permissions/permissions.ts
 */

import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMode,
  PermissionResult,
  PermissionRule,
  ToolPermissionContext,
  McpToolSource,
  LocalToolPermission,
} from './types.js'
import {
  DEFAULT_LOCAL_TOOL_PERMISSION,
  HOST_PERMISSION_GRANTED,
  HOST_PERMISSION_DENIED,
} from './types.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './rules.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
  type DenialTrackingState,
} from './classifier.js'
import {
  classifyAction,
  recordAutoModeDenial,
  isAutoModeAllowlistedTool,
} from './classifier.js'
import {
  riskTierToBehavior,
  analyzeCommandSafety,
  isReadOnlyCommand,
  isCatastrophicToolCall,
  isToolWithinWorkspace,
  isWorkspaceEscapingCommand,
  isFileTool,
  isShellTool,
  isBypassMode,
} from './policy.js'
import type { AIClient } from '@duya/ai'
import type { Message } from '../types.js'
import {
  checkPowerShellSecurity,
  isReadOnlyPowerShellCommand,
} from '../tool/PowerShellTool/security.js'
// Plan 449: connector approval memory + templated approval messages.
import { isSessionApproved } from '../tool/AppConnectionTool/approvals.js'
import { renderConnectorApprovalFromDescriptor } from '../tool/AppConnectionTool/approval-message.js'
import { getCachedAppConnectionDescriptors } from '../tool/AppConnectionTool/index.js'
import { getPermissionPrescreener } from '../decisions/index.js'
import { logger } from '../utils/logger.js'

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

/**
 * Tools that only interact with the application's own internal state or
 * read-only app metadata. They do not touch user files, external systems,
 * or the network, so they should not be gated by permission modes.
 */
const GLOBAL_ALWAYS_ALLOWED_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'SwitchMode',
  'MessageSession',
  'SendMessage',
  'Brief',
  'show_widget',
  'read_module',
  'SessionSearch',
  'ToolSearch',
  'LSP',
  'todo',
  'task',
  'Agent',
  'Task',
  'send_artifact',
])

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

// ─── content-scoped rules (`Tool(pattern)`) ───
//
// A rule string like `Bash(rm -rf:*)` parses into `{ toolName: 'Bash',
// ruleContent: 'rm -rf:*' }`. The tool-name lookups above deliberately skip
// those rules (`toolMatchesRule` returns false when `ruleContent` is set), so
// a content rule is enforced HERE and nowhere else: it is a narrowing of the
// same deny, consulted at the same step-1 priority as the tool-name deny, so
// the two can never disagree about which one wins.

/** Compiled-glob cache. Rule contents come from user settings and are few. */
const ruleContentRegExpCache = new Map<string, RegExp>()

/**
 * Translate a rule content into an anchored glob RegExp. `*` matches any run
 * of characters, `?` a single one; everything else is literal. The parser has
 * already unescaped `\(` / `\)` / `\\` (see `rules.ts`), so those are literal
 * characters here, not regex groups.
 */
function ruleContentToRegExp(pattern: string): RegExp {
  const cached = ruleContentRegExpCache.get(pattern)
  if (cached) return cached
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += '[\\s\\S]*'
    else if (ch === '?') source += '[\\s\\S]'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const compiled = new RegExp(`^(?:${source})$`)
  // Bound the cache so a pathological settings file cannot grow it forever.
  if (ruleContentRegExpCache.size >= 256) ruleContentRegExpCache.clear()
  ruleContentRegExpCache.set(pattern, compiled)
  return compiled
}

/**
 * Shell separators a rule prefix can be scoped to. A content rule is written
 * as a PREFIX of a command, so `Bash(rm -rf:*)` has to match the `rm -rf …`
 * segment of `git status && rm -rf build` — not just a whole-command prefix.
 * `sudo` and other leading words are NOT stripped: a prefix that does not
 * literally appear in the command does not match, which is the fail-closed
 * reading of what the user typed.
 */
const SHELL_SEGMENT_SPLIT = /(?:\r?\n|&&|\|\||;|\|)/

/**
 * The string a content rule for this tool is matched against. Returns
 * undefined when the tool has no canonical content field, so no content rule
 * can match it (a tool with no addressable content has nothing to scope to).
 */
function toolInputToRuleContent(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (isShellTool(toolName)) {
    return typeof input.command === 'string' ? input.command : undefined
  }
  if (isFileTool(toolName)) {
    const path = input.file_path ?? input.path
    return typeof path === 'string' ? path : undefined
  }
  if (toolName === 'Grep') {
    return typeof input.pattern === 'string' ? input.pattern : undefined
  }
  // `Bash(...)` / `Write(...)` on an unknown tool: fall back to the most
  // specific string field the input has, so a content rule on a connector tool
  // is not silently dead. Order matters — command > path > pattern.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url'] as const) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * The content-scoped rule of the given behavior that covers this call, if the
 * user configured one. `getRuleByContentsForToolName` gives the candidates;
 * the match is an exact glob against the tool's content string (or, for a
 * shell tool, against any shell-separated segment of it).
 *
 * All three behaviors go through the one lookup on purpose. It used to be
 * deny-only, which left `Bash(rm -rf:*)` under "allow" and under "ask"
 * parsed, stored and displayed as active rules that silently did nothing —
 * an asymmetry the deny wiring had already fixed for its own behavior.
 */
export function getContentRuleForTool(
  context: ToolPermissionContext,
  toolName: string,
  input: Record<string, unknown>,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  const candidates = getRuleByContentsForToolName(context, toolName, behavior)
  if (candidates.size === 0) return null
  const content = toolInputToRuleContent(toolName, input)
  if (content === undefined) return null
  // A shell rule is written as a PREFIX of a command, so it has to be able to
  // match one segment of a compound command. A file path / pattern is a
  // single value and is matched whole — splitting it would be wrong.
  const haystacks = isShellTool(toolName)
    ? content.split(SHELL_SEGMENT_SPLIT).map((segment: string) => segment.trim()).filter(Boolean)
    : [content]
  if (haystacks.length === 0) return null
  for (const [pattern, rule] of candidates) {
    const re = ruleContentToRegExp(pattern)
    if (haystacks.some((candidate) => re.test(candidate))) return rule
  }
  return null
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

const LOW_RISK_BROWSER_OPERATIONS = new Set([
  'navigate',
  'snapshot',
  'scroll',
  'hover',
  'wait',
  'screenshot',
  'go_back',
  'parallel_fetch',
  'tabs_list',
  'tabs_new',
  'tabs_close',
  'tabs_select',
  'close_window',
]);

const CANVAS_TOOL_PREFIX = 'canvas_';

function isCanvasTool(toolName: string): boolean {
  return toolName.startsWith(CANVAS_TOOL_PREFIX) || toolName === 'database_manage';
}

export interface ToolPermissionCheckContext {
  getAppState: () => {
    toolPermissionContext: ToolPermissionContext
    denialTracking?: DenialTrackingState
  }
  setAppState?: (fn: (prev: unknown) => { denialTracking?: DenialTrackingState }) => void
  localDenialTracking?: DenialTrackingState
  abortController: AbortController
  /**
   * Provenance of an MCP tool (bundled/settings/plugin/local/unknown). When
   * present, the gate trusts only bundled + settings servers automatically and
   * prompts for third-party sources — see the short-circuit in
   * `hasPermissionsToUseTool`. Absent for built-in tools.
   */
  source?: McpToolSource
  /** LLM client for auto mode classifier */
  llmClient?: AIClient
  /** Model name for auto mode classifier */
  classifierModel?: string
  /** Messages for auto mode classifier transcript */
  messages?: Message[]
}

export type HasPermissionsFn = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionCheckContext,
) => Promise<PermissionDecision>

/**
 * Shared MCP source predicate — the single decision for MCP tools by their
 * provenance (`bundled`/`settings`/`plugin`/`local`/`unknown`) and the active
 * mode. Both the unified gate (`hasPermissionsToUseTool`, step 0) and the MCP
 * executor in `mcp/apply.ts` call this, so the MCP permission decision lives
 * in exactly one place. Never silently auto-approves third-party sources.
 */
export function decideMcpSource(
  source: McpToolSource,
  mode: PermissionMode | undefined,
  toolName: string,
): PermissionDecision {
  if (source === 'bundled') {
    return {
      behavior: 'allow',
      decisionReason: {
        type: 'safetyCheck',
        reason: 'bundled MCP tools are trusted first-party',
        classifierApprovable: false,
      },
    }
  }
  if (mode === 'bypassPermissions' || mode === 'dontAsk') {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode },
    }
  }
  if (source === 'settings') {
    return {
      behavior: 'allow',
      decisionReason: {
        type: 'safetyCheck',
        reason: `user-configured MCP server tool "${toolName}" is trusted by explicit user configuration`,
        classifierApprovable: false,
      },
    }
  }
  // plugin / local / unknown — never silently auto-approved.
  return {
    behavior: 'ask',
    message: `MCP tool "${toolName}" requires explicit user approval`,
    decisionReason: {
      type: 'other',
      reason: `MCP tool "${toolName}" with third-party provenance requires explicit user approval`,
    },
  }
}

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

    // 0. MCP source gate — the same gate used by built-in tools, extended with
    // the MCP provenance dimension. When `context.source` is present this
    // short-circuits before the built-in ordering so third-party MCP tools
    // (market-installed `plugin` / manual-path `local` / `unknown`) stay behind
    // a prompt even when the rest of the pipeline would auto-allow. `bundled`
    // (trusted first-party) and `settings` (explicit user config = trust) are
    // allowed automatically; `bypassPermissions` / `dontAsk` override the
    // source prompt, mirroring the role the old `evaluateMcpToolPermission`
    // played before it was folded into this single gate.
    const source = context.source
    if (source) {
      return decideMcpSource(source, appState.toolPermissionContext.mode, toolName)
    }

    // 1. Check if the tool is denied. A deny rule is explicit user
    // configuration, so it outranks every built-in allow gate below: the
    // canvas tools and the `GLOBAL_ALWAYS_ALLOWED_TOOLS` set used to be
    // consulted first, which silently discarded a configured deny rule for
    // any tool in that set (or for `canvas_*` / `database_manage`).
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

    // 1b. Same priority, narrower scope: a content-scoped deny rule
    // (`Bash(rm -rf:*)`). The tool-name lookup above cannot match it —
    // `toolMatchesRule` skips any rule carrying content — so without this
    // step such a rule would parse, be stored, be shown to the user as an
    // active deny, and never deny anything. Consulted here rather than in
    // `PermissionsGate` so the gate's step-1 tool-name check stays the single
    // pre-gate fast path and this verdict arrives through the same
    // `decision.behavior === 'deny'` branch it already handles.
    const contentDenyRule = getContentRuleForTool(
      appState.toolPermissionContext,
      toolName,
      input,
      'deny',
    )
    if (contentDenyRule) {
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'rule',
          rule: contentDenyRule,
        },
        message: `Permission to use ${toolName} with this input has been denied by a content rule (${permissionRuleValueToString(contentDenyRule.ruleValue)}).`,
      }
    }

    // 1c. Same reasoning as step 1, applied to "ask": a content-scoped ask
    // rule is explicit user configuration, so it has to outrank the built-in
    // allow gates below — most visibly `GLOBAL_ALWAYS_ALLOWED_TOOLS` at step
    // 3, which would otherwise auto-allow a call the user explicitly asked to
    // be confirmed every time. Placed here, beside the content deny, for the
    // same reason: at step 4 (beside the tool-name ask) it would already be
    // shadowed by step 3 and would stay as unenforced as it was before.
    const contentAskRule = getContentRuleForTool(
      appState.toolPermissionContext,
      toolName,
      input,
      'ask',
    )
    if (contentAskRule) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: contentAskRule,
        },
        message: `Permission to use ${toolName} with this input requires approval by a content rule (${permissionRuleValueToString(contentAskRule.ruleValue)}).`,
      }
    }

    // 2. Canvas and project-database tools operate entirely within the
    // application's own project workspace. They do not touch external systems, so they
    // must be unconditionally allowed regardless of permission mode. User deny
    // rules still win — they were checked in step 1.
    if (isCanvasTool(toolName)) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'safetyCheck',
          reason: `${toolName} is an internal canvas operation.`,
          classifierApprovable: false,
        },
      }
    }

    // 3. Internal-only tools that only read or mutate the application's own
    // state should not be gated by permission modes. User deny rules are the
    // exception and were checked in step 1.
    if (GLOBAL_ALWAYS_ALLOWED_TOOLS.has(toolName)) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'safetyCheck',
          reason: `${toolName} is an internal application operation.`,
          classifierApprovable: false,
        },
      }
    }

    // 4. Check if the entire tool should always ask for permission
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

    // 4.5 Plan 312 Phase 4: risk-tier gating for connector tools.
    // Connector tools declare a `riskTier` (read/draft/write/modify/
    // destructive). The tier is looked up via the context's
    // `getToolRiskTier` callback (wired to ToolRegistry.getMeta).
    // `write`/`modify` → ask; `destructive` → strong confirm that
    // overrides bypassPermissions; `read`/`draft` → fall through to
    // the normal flow. Missing tier → conservative bump to `write`.
    const riskTier = appState.toolPermissionContext.getToolRiskTier?.(toolName);
    if (riskTier !== undefined) {
      const tierBehavior = riskTierToBehavior(riskTier, appState.toolPermissionContext.mode);
      const connectorDescriptor = getCachedAppConnectionDescriptors().find(
        (d) => d.name === toolName,
      );
      if (tierBehavior === 'strong-confirm') {
        return {
          behavior: 'ask',
          message: `${toolName} is a destructive connector action and requires explicit confirmation.`,
          decisionReason: {
            type: 'safetyCheck',
            reason: `riskTier=destructive requires strong confirmation regardless of permission mode.`,
            classifierApprovable: false,
          },
        };
      }
      if (tierBehavior === 'ask') {
        // Plan 449: approval memory — a globally approved (preApproved,
        // stamped by main) or session-approved connector tool skips the ask.
        // Destructive never reaches this branch (strong-confirm above), so
        // the exemption is write/modify-only by construction.
        //
        // NOTE: this returns 'allow' directly instead of falling through —
        // in default mode the pipeline's final fallback asks for ANY unknown
        // tool, which would defeat the memory. Remote connector calls are
        // out-of-workspace HTTP actions by definition; the workspace and
        // catastrophic file checks below do not apply to them.
        const approvalExempt =
          connectorDescriptor !== undefined &&
          (connectorDescriptor.preApproved === true || isSessionApproved(toolName));
        if (approvalExempt) {
          return {
            behavior: 'allow',
            decisionReason: {
              type: 'safetyCheck',
              reason: `User approved ${toolName} (connector approval memory).`,
              classifierApprovable: false,
            },
          };
        }
        const message = connectorDescriptor
          ? renderConnectorApprovalFromDescriptor(connectorDescriptor, input).message
          : createPermissionRequestMessage(toolName);
        return {
          behavior: 'ask',
          message,
          decisionReason: {
            type: 'safetyCheck',
            reason: `riskTier=${riskTier} requires confirmation before execution.`,
            classifierApprovable: false,
          },
        };
      }
      // tierBehavior === undefined → fall through (read/draft or
      // write/modify in bypass mode). The normal flow handles it.
    }

    // 4.7 Catastrophic safety check — NEVER bypassed, even in bypassPermissions
    // mode. This runs BEFORE the mode bypass short-circuit so catastrophic
    // operations are caught even when the executor skips checkPermissions
    // (which happens when canUseTool returns behavior='allow' in bypass mode).
    // Without this, a user in bypass mode could write to C:\Windows\System32
    // or run `rm -rf /` because checkPermissions would be skipped.
    const toolWorkingDir = (typeof input.cwd === 'string' ? input.cwd : undefined)
      ?? appState.toolPermissionContext.defaultWorkspaceDirectory;
    if (isCatastrophicToolCall(toolName, input, toolWorkingDir)) {
      return {
        behavior: 'deny',
        message: `Operation denied: catastrophic safety boundary reached. This operation could cause unrecoverable system damage and is blocked even in bypass mode.`,
        decisionReason: {
          type: 'safetyCheck',
          reason: `${toolName} matched a catastrophic safety pattern that is never bypassed, even in bypassPermissions mode.`,
          classifierApprovable: false,
        },
      }
    }

    // 4.8 Plan 487 — host-level standing permission switch. Runs AFTER
    // catastrophic (step 4.7) so catastrophic safety boundaries are never
    // overridden by the host switch, and BEFORE mode bypass (step 5) so
    // an explicit per-session bypassPermissions / dontAsk still wins
    // (the user's session-level intent is respected). When the host
    // switch is set, the session mode is one of `default / acceptEdits
    // / plan / auto / bubble` — i.e. not explicit bypass — and the host
    // switch overrides the prompt pipeline.
    const hostPermission: LocalToolPermission =
      appState.toolPermissionContext.hostToolPermission ?? DEFAULT_LOCAL_TOOL_PERMISSION;
    // `isBypassMode` is the single definition of "this session never asks
    // again" (policy.ts). It is used here and in `resolveAskWithoutUser`, so
    // the pipeline and the headless `ask` fallbacks cannot disagree about
    // which modes that is. `plan` is deliberately NOT a member: it is a
    // read-only planning mode whose writes must still be gated. The old
    // inline `mode === 'plan' && isBypassPermissionsModeAvailable` clause
    // made the pipeline allow everything in plan mode (production always
    // passes `true`) while all three ask-fallbacks denied.
    const sessionModeIsExplicitBypass = isBypassMode(appState.toolPermissionContext.mode);
    // Step 5's mode short-circuit, hoisted so the pre-screen below can see
    // whether the pipeline is about to auto-allow (identical predicate).
    const shouldBypassPermissions = isBypassMode(appState.toolPermissionContext.mode);

    // 4.75 Plan 551 — System One risk pre-screen (infra channel, default
    // off). Fires ONLY when the pipeline is about to auto-allow (host
    // switch 'always' or session-mode bypass); ordinary prompt paths never
    // wait on it. The result is a SUGGESTION: the decision below is
    // unchanged either way (plan 551 Non-Goals — Jev 只产出建议), the note
    // lands in decisionReason + the log for audit and calibration.
    let prescreenNote = ''
    if (
      shouldBypassPermissions ||
      (hostPermission === 'always' && !sessionModeIsExplicitBypass)
    ) {
      const prescreener = getPermissionPrescreener()
      if (prescreener) {
        const suggestion = await prescreener(toolName, input)
        if (suggestion?.suggestion === 'gate') {
          prescreenNote = ` [jev:suggest_gate p=${suggestion.p.toFixed(2)}]`
        }
      }
    }

    if (!sessionModeIsExplicitBypass) {
      if (hostPermission === 'always') {
        return {
          behavior: 'allow',
          decisionReason: {
            type: 'safetyCheck',
            reason: `${HOST_PERMISSION_GRANTED}: host-level permission switch is set to 'always'; auto-allowed without prompt.${prescreenNote}`,
            classifierApprovable: false,
          },
        };
      }
      if (hostPermission === 'never') {
        return {
          behavior: 'deny',
          message: `Operation denied: host-level permission switch is set to 'never'. All non-internal tools are blocked at the host level. Switch it to 'ask' or 'always' in Settings to allow tool use.`,
          decisionReason: {
            type: 'safetyCheck',
            reason: `${HOST_PERMISSION_DENIED}: host-level permission switch is set to 'never'; auto-denied regardless of session mode.`,
            classifierApprovable: false,
          },
        };
      }
      // hostPermission === 'ask' — fall through to step 5 (mode bypass) and beyond.
    }

    // 5. Check mode-based permissions. `bypassPermissions` and `dontAsk`
    // both mean "don't prompt the user". `dontAsk` is the headless /
    // background read-only mode used by the CLI and automation surfaces,
    // where automated commands and app-internal tools must not block on a
    // permission dialog nobody can answer.
    if (shouldBypassPermissions) {
      if (prescreenNote) {
        // Pre-screen suggestion on the bypass path: decision unchanged
        // (the 'mode' reason shape carries no free-text field), audit-only.
        logger.warn(`permission prescreen suggests gate${prescreenNote}`, { toolName })
      }
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'mode',
          mode: appState.toolPermissionContext.mode,
        },
      }
    }

    // 6. Check if entire tool is allowed
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

    // 6b. Content-scoped counterpart of step 6, for the same reason step 1b
    // sits beside step 1: `toolAlwaysAllowedRule` cannot match a rule that
    // carries content, so `Bash(git status:*)` under "allow" parsed, was
    // listed as active, and never allowed anything. Sits here rather than
    // earlier because an allow rule is the weakest user signal in the
    // pipeline — it must not outrank the deny (1b), ask (1c) or
    // catastrophic-safety (4.7) checks, and by step 6 all of those have run.
    const contentAllowRule = getContentRuleForTool(
      appState.toolPermissionContext,
      toolName,
      input,
      'allow',
    )
    if (contentAllowRule) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'rule',
          rule: contentAllowRule,
        },
      }
    }

    // 7. Check if the tool operates within the workspace directory
    if (isToolWithinWorkspace(toolName, input, appState.toolPermissionContext)) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'workingDir',
          reason: `${toolName} operates within the workspace directory.`,
        },
      }
    }

    // 8. Auto mode: default-allow workspace-confined actions (grok-style
    // workspace trust). Normal exploration, builds, npm install, and file
    // edits inside the workspace run without the LLM classifier; only
    // actions that escape the workspace (cd outside, system-dir writes) or
    // are otherwise unverifiable fall through to the classifier below.
    const isAutoMode = appState.toolPermissionContext.mode === 'auto';
    if (isAutoMode && isAutoModeWorkspaceSafe(toolName, input, appState.toolPermissionContext)) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'safetyCheck',
          reason: `${toolName} operates within the workspace in auto mode.`,
          classifierApprovable: false,
        },
      };
    }

    // 9. Auto mode: use AI classifier instead of prompting user. Only
    // actions that escaped the workspace reach here.
    if (isAutoMode && context.llmClient && context.classifierModel) {
      const denialState =
        appState.denialTracking ??
        context.localDenialTracking ??
        createDenialTrackingState();

      // Run the classifier
      const result = await classifyAction({
        llmClient: context.llmClient,
        model: context.classifierModel,
        messages: context.messages ?? [],
        toolName,
        toolInput: input,
        context: appState.toolPermissionContext,
        signal: context.abortController.signal,
      });

      // Classifier unavailable (error, abort, unparseable) — fall back to a
      // manual approval prompt instead of denying. A classifier that cannot
      // decide must not silently reject the agent's work.
      if (result.unavailable) {
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(toolName),
          decisionReason: {
            type: 'other',
            reason: 'Auto mode classifier unavailable - manual approval required',
          },
        };
      }

      // Genuine classifier block — deny, with circuit breaker / denial history.
      if (result.shouldBlock) {
        const newDenialState = recordDenial(denialState);
        persistDenialState(context, newDenialState);

        recordAutoModeDenial({
          toolName,
          display: summarizeToolInput(toolName, input),
          reason: result.reason,
          timestamp: Date.now(),
        });

        // Check if denial limit exceeded - if so, show a specific message
        const limitExceeded = handleDenialLimitExceeded(
          newDenialState,
          toolName,
          result.reason,
        );
        if (limitExceeded) {
          return limitExceeded;
        }

        // Classifier blocked but under limits - return deny
        return {
          behavior: 'deny',
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: result.reason,
          },
          message: `Auto mode blocked ${toolName}: ${result.reason}`,
        };
      }

      // Classifier allowed - record success and allow
      const successState = recordSuccess(denialState);
      persistDenialState(context, successState);

      return {
        behavior: 'allow',
        decisionReason: {
          type: 'classifier',
          classifier: 'auto-mode',
          reason: result.reason,
        },
      };
    }

    // Default: ask for permission
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(toolName),
    }
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return input.command.length > 100
      ? input.command.slice(0, 100) + '...'
      : input.command;
  }
  if (typeof input.file_path === 'string') {
    return `${toolName}: ${input.file_path}`;
  }
  if (typeof input.path === 'string') {
    return `${toolName}: ${input.path}`;
  }
  return toolName;
}

function isLocallySafeAutoModeAction(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (isAutoModeAllowlistedTool(toolName)) {
    return true;
  }

  if (isLowRiskBrowserOperation(toolName, input)) {
    return true;
  }

  if (typeof input.command !== 'string') {
    return false;
  }

  if (toolName === 'Bash' || toolName === 'bash') {
    const securityResult = analyzeCommandSafety(input.command);
    return (
      securityResult.safe &&
      !securityResult.requiresApproval &&
      isReadOnlyCommand(input.command)
    );
  }

  if (toolName === 'powershell' || toolName === 'PowerShell') {
    const securityResult = checkPowerShellSecurity(input.command);
    return (
      securityResult.safe &&
      !securityResult.requiresApproval &&
      isReadOnlyPowerShellCommand(input.command)
    );
  }

  return false;
}

/**
 * Decide whether a tool action is safe to default-allow in auto mode.
 *
 * Modeled on grok/deepseek-harness workspace trust: anything confined to the
 * workspace — reads, writes, builds, package installs, file edits — is allowed
 * without the LLM classifier. Only actions that escape the workspace (shell
 * `cd` outside, redirection to system dirs, secret access) or are otherwise
 * unverifiable fall through to the classifier.
 */
function isAutoModeWorkspaceSafe(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
): boolean {
  // Allowlisted read-only/metadata tools and low-risk browser ops.
  if (isLocallySafeAutoModeAction(toolName, input)) {
    return true;
  }

  if (isShellTool(toolName)) {
    const command = typeof input.command === 'string' ? input.command : '';
    return !isWorkspaceEscapingCommand(command, context);
  }

  // File/content tools: contained within the workspace, or path-less
  // (cwd-relative, therefore within the workspace).
  if (isFileTool(toolName)) {
    if (isToolWithinWorkspace(toolName, input, context)) return true;
    // No explicit path (e.g. apply_patch) resolves against the session cwd,
    // which is the workspace — trust it.
    return !hasExplicitPath(input);
  }

  return false;
}

function hasExplicitPath(input: Record<string, unknown>): boolean {
  return (
    typeof input.path === 'string' ||
    typeof input.file_path === 'string' ||
    typeof input.directory === 'string' ||
    Array.isArray(input.paths)
  );
}

function isLowRiskBrowserOperation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName !== 'browser') {
    return false;
  }

  if (typeof input.operation !== 'string') {
    return false;
  }

  if (input.operation === 'parallel_fetch' && typeof input.evaluate === 'string' && input.evaluate.trim()) {
    return false;
  }

  return LOW_RISK_BROWSER_OPERATIONS.has(input.operation);
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

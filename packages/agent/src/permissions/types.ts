/**
 * Permission system type definitions for duya Agent
 * Adapted from claude-code-haha/src/types/permissions.ts
 */

// ============================================================================
// Permission Modes
// ============================================================================

/**
 * Provenance bucket of an MCP tool. Used by the unified permission gate to
 * trust first-party / user-configured servers without prompting, while keeping
 * market-installed or manual-path third-party tools behind a prompt.
 */
export type McpToolSource = 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown'

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// Exhaustive mode union for typechecking
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode

// Runtime validation set: modes that are user-addressable
export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'auto',
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

// ============================================================================
// Host-Level Standing Permission (Plan 487)
// ============================================================================

/**
 * Host-level persistent tool permission switch (plan 487). Persisted as a
 * settings KV (`host.localToolPermission`) and injected into every agent
 * process's `ToolPermissionContext` at boot. Complements the per-session
 * `PermissionMode`:
 *
 *   - `ask`    — every non-internal tool call that would have prompted the
 *                user continues to prompt (default).
 *   - `always` — auto-allow, short-circuiting the prompt layer with a
 *                `safetyCheck` reason tagged `HOST_PERMISSION_GRANTED`.
 *   - `never`  — auto-deny, short-circuiting the prompt layer with a
 *                `safetyCheck` reason tagged `HOST_PERMISSION_DENIED`.
 *
 * The host switch never overrides (a) `CATASTROPHIC` safety boundaries or
 * (b) sessions whose mode is an explicit `bypassPermissions` / `dontAsk`
 * (the user's explicit per-session intent wins). The gate in
 * `hasPermissionsToUseTool` runs the check between step 4.7 (catastrophic)
 * and step 5 (mode bypass) so session-level `default/acceptEdits/plan/
 * auto/bubble` is gated by the host switch while explicit bypass is not.
 */
export type LocalToolPermission = 'ask' | 'always' | 'never'

export const LOCAL_TOOL_PERMISSIONS: readonly LocalToolPermission[] = [
  'ask',
  'always',
  'never',
] as const

export const DEFAULT_LOCAL_TOOL_PERMISSION: LocalToolPermission = 'ask'

/**
 * Reasons stamped on `decisionReason` when the host switch decides a tool
 * call. Surfaced in the audit log so the user can trace "why did this
 * command not prompt / not run".
 */
export const HOST_PERMISSION_GRANTED = 'HOST_PERMISSION_GRANTED' as const
export const HOST_PERMISSION_DENIED = 'HOST_PERMISSION_DENIED' as const

// ============================================================================
// Permission Behaviors
// ============================================================================

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// ============================================================================
// Permission Rules
// ============================================================================

/**
 * Where a permission rule originated from.
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/**
 * The value of a permission rule - specifies which tool and optional content
 */
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

/**
 * A permission rule with its source and behavior
 */
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

// ============================================================================
// Permission Updates
// ============================================================================

/**
 * Where a permission update should be persisted
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/**
 * Update operations for permission configuration
 */
export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

/**
 * Source of an additional working directory permission.
 */
export type WorkingDirectorySource = PermissionRuleSource

/**
 * An additional directory included in permission scope
 */
export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

// ============================================================================
// Permission Decisions & Results
// ============================================================================

/**
 * Minimal command shape for permission metadata.
 */
export type PermissionCommandMetadata = {
  name: string
  description?: string
  [key: string]: unknown
}

/**
 * Plan 450 Phase D: structured tool-parameter display payload for
 * app-connection approval cards. The renderer surfaces these as tidy
 * label:value rows instead of raw JSON.
 */
export type ConnectorToolParamsDisplay = Array<{
  name: string;
  label: string;
  value: string;
}>;

/**
 * Metadata attached to permission decisions
 */
export type PermissionMetadata =
  | { command: PermissionCommandMetadata }
  | {
      connector: {
        provider: string;
        toolParamsDisplay: ConnectorToolParamsDisplay;
      };
    }
  | undefined

/**
 * Result when permission is granted
 */
export type PermissionAllowDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'allow'
  updatedInput?: Input
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
}

/**
 * Metadata for a pending classifier check that will run asynchronously.
 */
export type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}

/**
 * Result when user should be prompted
 */
export type PermissionAskDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'ask'
  message: string
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  pendingClassifierCheck?: PendingClassifierCheck
}

/**
 * Result when permission is denied
 */
export type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

/**
 * A permission decision - allow, ask, or deny
 */
export type PermissionDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision

/**
 * Permission result with additional passthrough option
 */
export type PermissionResult<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecision<Input>['decisionReason']
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      pendingClassifierCheck?: PendingClassifierCheck
    }

/**
 * Explanation of why a permission decision was made
 */
export type PermissionDecisionReason =
  | {
      type: 'rule'
      rule: PermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'subcommandResults'
      reasons: Map<string, PermissionResult>
    }
  | {
      type: 'permissionPromptTool'
      permissionPromptToolName: string
      toolResult: unknown
    }
  | {
      type: 'hook'
      hookName: string
      hookSource?: string
      reason?: string
    }
  | {
      type: 'asyncAgent'
      reason: string
    }
  | {
      type: 'sandboxOverride'
      reason: 'excludedCommand' | 'dangerouslyDisableSandbox'
    }
  | {
      type: 'classifier'
      classifier: string
      reason: string
    }
  | {
      type: 'workingDir'
      reason: string
    }
  | {
      type: 'safetyCheck'
      reason: string
      classifierApprovable: boolean
    }
  | {
      type: 'other'
      reason: string
    }

// ============================================================================
// Bash Classifier Types
// ============================================================================

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export type ClassifierUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export type YoloClassifierResult = {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  transcriptTooLong?: boolean
  model: string
  usage?: ClassifierUsage
  durationMs?: number
  promptLengths?: {
    systemPrompt: number
    toolCalls: number
    userPrompts: number
  }
  errorDumpPath?: string
  stage?: 'fast' | 'thinking'
  stage1Usage?: ClassifierUsage
  stage1DurationMs?: number
  stage1RequestId?: string
  stage1MsgId?: string
  stage2Usage?: ClassifierUsage
  stage2DurationMs?: number
  stage2RequestId?: string
  stage2MsgId?: string
}

// ============================================================================
// Permission Explainer Types
// ============================================================================

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

// ============================================================================
// Tool Permission Context
// ============================================================================

/**
 * Mapping of permission rules by their source
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
}

/**
 * Context needed for permission checking in tools
 */
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
  readonly defaultWorkspaceDirectory?: string
  /**
   * Plan 312 Phase 4: optional lookup for connector tool risk tiers.
   * Returns `undefined` for non-connector tools (no tier-based gating).
   * The DuyaAgent wires this to `ToolRegistry.getMeta(name)?.riskTier`.
   */
  readonly getToolRiskTier?: (toolName: string) => import('./policy.js').RiskTier | undefined

  /**
   * Plan 487: host-level persistent tool permission switch. Read from
   * settings KV at boot and injected once per agent process. Optional so
   * older agent processes keep working — when undefined, the gate in
   * `hasPermissionsToUseTool` treats the effective switch as `'ask'`.
   */
  readonly hostToolPermission?: LocalToolPermission
}

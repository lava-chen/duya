/**
 * Hook types for duya Agent
 *
 * Adapted from claude-code-haha/src/types/hooks.ts
 */

import { z } from 'zod';

// ============================================================================
// Hook Events
// ============================================================================

/**
 * Hook events that can be triggered during agent execution
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Setup',
  'SubagentStart',
  'SubagentStop',
  'PermissionDenied',
  'PermissionRequest',
  'Elicitation',
  'ElicitationResult',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreTurn',
  'PostTurn',
  'PreFinalize',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'InstructionsLoaded',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Check if a string is a valid hook event
 */
export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.includes(value as HookEvent);
}

// ============================================================================
// Hook Input Schemas
// ============================================================================

/**
 * Base hook input schema shared by all hook types
 */
export const BaseHookInputSchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional().describe('Subagent identifier'),
  agent_type: z.string().optional().describe('Agent type name'),
});

export type BaseHookInput = z.infer<typeof BaseHookInputSchema>;

/**
 * PreToolUse hook input
 */
export const PreToolUseHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
});

export type PreToolUseHookInput = z.infer<typeof PreToolUseHookInputSchema>;

/**
 * PostToolUse hook input
 */
export const PostToolUseHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  tool_use_id: z.string(),
});

export type PostToolUseHookInput = z.infer<typeof PostToolUseHookInputSchema>;

/**
 * PostToolUseFailure hook input
 */
export const PostToolUseFailureHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolUseFailure'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
  error: z.string(),
  is_interrupt: z.boolean().optional(),
});

export type PostToolUseFailureHookInput = z.infer<typeof PostToolUseFailureHookInputSchema>;

/**
 * PermissionDenied hook input
 */
export const PermissionDeniedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PermissionDenied'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
  reason: z.string(),
});

export type PermissionDeniedHookInput = z.infer<typeof PermissionDeniedHookInputSchema>;

/**
 * Notification hook input
 */
export const NotificationHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('Notification'),
  message: z.string(),
  title: z.string().optional(),
  notification_type: z.string(),
});

export type NotificationHookInput = z.infer<typeof NotificationHookInputSchema>;

/**
 * UserPromptSubmit hook input
 */
export const UserPromptSubmitHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
});

export type UserPromptSubmitHookInput = z.infer<typeof UserPromptSubmitHookInputSchema>;

/**
 * SessionStart hook input
 */
export const SessionStartHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  source: z.enum(['startup', 'resume', 'clear', 'compact']),
});

export type SessionStartHookInput = z.infer<typeof SessionStartHookInputSchema>;

/**
 * Setup hook input
 */
export const SetupHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('Setup'),
  trigger: z.enum(['init', 'maintenance']),
});

export type SetupHookInput = z.infer<typeof SetupHookInputSchema>;

/**
 * SubagentStart hook input
 */
export const SubagentStartHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('SubagentStart'),
  agent_id: z.string(),
  agent_type: z.string(),
});

export type SubagentStartHookInput = z.infer<typeof SubagentStartHookInputSchema>;

/**
 * PermissionRequest hook input
 */
export const PermissionRequestHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: z.unknown(),
});

export type PermissionRequestHookInput = z.infer<typeof PermissionRequestHookInputSchema>;

/**
 * Elicitation hook input
 */
export const ElicitationHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('Elicitation'),
  mcp_server_name: z.string(),
  message: z.string(),
  mode: z.enum(['form', 'url']).optional(),
  url: z.string().optional(),
  elicitation_id: z.string().optional(),
  requested_schema: z.record(z.string(), z.unknown()).optional(),
});

export type ElicitationHookInput = z.infer<typeof ElicitationHookInputSchema>;

/**
 * ElicitationResult hook input
 */
export const ElicitationResultHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('ElicitationResult'),
  mcp_server_name: z.string(),
  elicitation_id: z.string().optional(),
  mode: z.enum(['form', 'url']).optional(),
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), z.unknown()).optional(),
});

export type ElicitationResultHookInput = z.infer<typeof ElicitationResultHookInputSchema>;

/**
 * CwdChanged hook input
 */
export const CwdChangedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('CwdChanged'),
  old_cwd: z.string(),
  new_cwd: z.string(),
});

export type CwdChangedHookInput = z.infer<typeof CwdChangedHookInputSchema>;

/**
 * FileChanged hook input
 */
export const FileChangedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('FileChanged'),
  file_path: z.string(),
  event: z.enum(['change', 'add', 'unlink']),
});

export type FileChangedHookInput = z.infer<typeof FileChangedHookInputSchema>;

/**
 * WorktreeCreate hook input
 */
export const WorktreeCreateHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('WorktreeCreate'),
  name: z.string(),
});

export type WorktreeCreateHookInput = z.infer<typeof WorktreeCreateHookInputSchema>;

/**
 * PreTurn hook input - fired before each LLM call
 */
export const PreTurnHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PreTurn'),
  turnCount: z.number(),
});

export type PreTurnHookInput = z.infer<typeof PreTurnHookInputSchema>;

/**
 * PostTurn hook input - fired after each LLM call completes
 */
export const PostTurnHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostTurn'),
  turnCount: z.number(),
});

export type PostTurnHookInput = z.infer<typeof PostTurnHookInputSchema>;

/**
 * PreFinalize hook input - fired when the model ends its turn naturally and
 * the engine is about to finalize (veto-capable point, plan 426)
 */
export const PreFinalizeHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PreFinalize'),
  turnCount: z.number(),
  stopReason: z.string().optional(),
});

export type PreFinalizeHookInput = z.infer<typeof PreFinalizeHookInputSchema>;

/**
 * SessionEnd hook input
 */
export const SessionEndHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('SessionEnd'),
  reason: z.enum(['user_exit', 'timeout', 'error', 'clear']).optional(),
});

export type SessionEndHookInput = z.infer<typeof SessionEndHookInputSchema>;

/**
 * PreCompact hook input
 */
export const PreCompactHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PreCompact'),
  trigger: z.enum(['auto', 'manual', 'idle']),
  compactConfig: z.record(z.string(), z.unknown()).optional(),
});

export type PreCompactHookInput = z.infer<typeof PreCompactHookInputSchema>;

/**
 * PostCompact hook input
 */
export const PostCompactHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostCompact'),
  trigger: z.enum(['auto', 'manual', 'idle']),
  messageCountBefore: z.number().optional(),
  messageCountAfter: z.number().optional(),
  error: z.string().optional(),
});

export type PostCompactHookInput = z.infer<typeof PostCompactHookInputSchema>;

/**
 * Stop hook input
 */
export const StopHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('Stop'),
  reason: z.enum(['user_request', 'system', 'error', 'timeout']),
});

export type StopHookInput = z.infer<typeof StopHookInputSchema>;

/**
 * StopFailure hook input
 */
export const StopFailureHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('StopFailure'),
  reason: z.enum(['user_request', 'system', 'error', 'timeout']),
  error: z.string(),
});

export type StopFailureHookInput = z.infer<typeof StopFailureHookInputSchema>;

/**
 * SubagentStop hook input
 */
export const SubagentStopHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string(),
  agent_type: z.string(),
  status: z.enum(['completed', 'error', 'cancelled', 'timeout']),
  summary: z.string().optional(),
  error: z.string().optional(),
});

export type SubagentStopHookInput = z.infer<typeof SubagentStopHookInputSchema>;

/**
 * TeammateIdle hook input
 */
export const TeammateIdleHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('TeammateIdle'),
  agent_id: z.string(),
  agent_type: z.string(),
});

export type TeammateIdleHookInput = z.infer<typeof TeammateIdleHookInputSchema>;

/**
 * TaskCreated hook input
 */
export const TaskCreatedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('TaskCreated'),
  task_id: z.string(),
  task_name: z.string(),
  task_context: z.record(z.string(), z.unknown()).optional(),
});

export type TaskCreatedHookInput = z.infer<typeof TaskCreatedHookInputSchema>;

/**
 * TaskCompleted hook input
 */
export const TaskCompletedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('TaskCompleted'),
  task_id: z.string(),
  task_name: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
});

export type TaskCompletedHookInput = z.infer<typeof TaskCompletedHookInputSchema>;

/**
 * ConfigChange hook input
 */
export const ConfigChangeHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('ConfigChange'),
  changed_keys: z.array(z.string()),
  old_values: z.record(z.string(), z.unknown()).optional(),
  new_values: z.record(z.string(), z.unknown()).optional(),
});

export type ConfigChangeHookInput = z.infer<typeof ConfigChangeHookInputSchema>;

/**
 * InstructionsLoaded hook input
 */
export const InstructionsLoadedHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('InstructionsLoaded'),
  instruction_source: z.string(),
  instruction_count: z.number().optional(),
});

export type InstructionsLoadedHookInput = z.infer<typeof InstructionsLoadedHookInputSchema>;

/**
 * WorktreeRemove hook input
 */
export const WorktreeRemoveHookInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('WorktreeRemove'),
  name: z.string(),
});

export type WorktreeRemoveHookInput = z.infer<typeof WorktreeRemoveHookInputSchema>;

/**
 * Union of all hook input types
 */
export const HookInputSchema = z.discriminatedUnion('hook_event_name', [
  PreToolUseHookInputSchema,
  PostToolUseHookInputSchema,
  PostToolUseFailureHookInputSchema,
  PermissionDeniedHookInputSchema,
  NotificationHookInputSchema,
  UserPromptSubmitHookInputSchema,
  SessionStartHookInputSchema,
  SessionEndHookInputSchema,
  SetupHookInputSchema,
  SubagentStartHookInputSchema,
  SubagentStopHookInputSchema,
  PermissionRequestHookInputSchema,
  ElicitationHookInputSchema,
  ElicitationResultHookInputSchema,
  CwdChangedHookInputSchema,
  FileChangedHookInputSchema,
  WorktreeCreateHookInputSchema,
  WorktreeRemoveHookInputSchema,
  PreCompactHookInputSchema,
  PostCompactHookInputSchema,
  PreTurnHookInputSchema,
  PostTurnHookInputSchema,
  PreFinalizeHookInputSchema,
  StopHookInputSchema,
  StopFailureHookInputSchema,
  TeammateIdleHookInputSchema,
  TaskCreatedHookInputSchema,
  TaskCompletedHookInputSchema,
  ConfigChangeHookInputSchema,
  InstructionsLoadedHookInputSchema,
]);

export type HookInput = z.infer<typeof HookInputSchema>;

// ============================================================================
// Hook Output Schemas
// ============================================================================

/**
 * Async hook response schema
 */
export const AsyncHookResponseSchema = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional(),
  asyncRewake: z.boolean().optional().describe('If true, wakes model when async hook completes'),
});

/**
 * Sync hook response schema
 */
export const SyncHookResponseSchema = z.object({
  continue: z.boolean().optional().describe('Whether to continue after hook'),
  suppressOutput: z.boolean().optional().describe('Hide stdout from transcript'),
  stopReason: z.string().optional().describe('Message shown when continue is false'),
  decision: z.enum(['approve', 'block']).optional().describe('Decision for the hook'),
  reason: z.string().optional().describe('Explanation for the decision'),
  systemMessage: z.string().optional().describe('Warning message shown to user'),
  hookSpecificOutput: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Hook JSON output schema
 */
export const HookJSONOutputSchema = z.union([
  AsyncHookResponseSchema,
  SyncHookResponseSchema,
]);

export type HookJSONOutput = z.infer<typeof HookJSONOutputSchema>;

// Type guards
export function isAsyncHookOutput(json: HookJSONOutput): json is z.infer<typeof AsyncHookResponseSchema> {
  return 'async' in json && json.async === true;
}

export function isSyncHookOutput(json: HookJSONOutput): json is z.infer<typeof SyncHookResponseSchema> {
  return !('async' in json && json.async === true);
}

// ============================================================================
// Hook Command Schemas
// ============================================================================

/**
 * Prompt command hook schema
 */
export const PromptCommandHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().describe('Prompt to send to LLM for evaluation'),
  if: z.string().optional().describe('Permission rule syntax to filter when hook runs'),
  model: z.string().optional().describe('Model override for this hook'),
  timeout: z.number().positive().optional().describe('Timeout in seconds'),
  statusMessage: z.string().optional().describe('Custom status message while hook runs'),
  once: z.boolean().optional().describe('If true, runs once and is removed'),
});

/**
 * Bash command hook schema
 */
export const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  if: z.string().optional().describe('Permission rule syntax to filter when hook runs'),
  shell: z.enum(['bash', 'powershell']).optional().describe('Shell interpreter'),
  timeout: z.number().positive().optional().describe('Timeout in seconds'),
  statusMessage: z.string().optional().describe('Custom status message while hook runs'),
  once: z.boolean().optional().describe('If true, runs once and is removed'),
  async: z.boolean().optional().describe('If true, runs in background without blocking'),
  asyncRewake: z.boolean().optional().describe('If true, wakes model on exit code 2'),
});

/**
 * Process hook schema (ZCode hooks.json alignment).
 *
 * Runs `command` directly (no shell) with an explicit `args` array — the
 * ZCode `process` executor shape. `timeoutMs` is in milliseconds (vs the
 * `command` hook's `timeout` in seconds). `command` and each `args` entry
 * are expanded through {@link expandHookTemplate} before spawn so plugin
 * roots / session paths can be injected via `${KEY}` placeholders.
 */
export const ProcessCommandHookSchema = z.object({
  type: z.literal('process'),
  command: z.string().describe('Executable to run (no shell interpretation)'),
  args: z.array(z.string()).optional().describe('Arguments passed to the executable'),
  timeoutMs: z.number().positive().optional().describe('Timeout in milliseconds'),
  statusMessage: z.string().optional().describe('Custom status message while hook runs'),
  if: z.string().optional().describe('Permission rule syntax to filter when hook runs'),
  once: z.boolean().optional().describe('If true, runs once and is removed'),
  async: z.boolean().optional().describe('If true, runs in background without blocking'),
  asyncRewake: z.boolean().optional().describe('If true, wakes model when async hook completes'),
});

/**
 * HTTP hook schema
 */
export const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
});

/**
 * Agent hook schema
 */
export const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string().describe('Prompt describing what to verify'),
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  model: z.string().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
});

/**
 * Hook command schema (discriminated union)
 */
export const HookCommandSchema = z.discriminatedUnion('type', [
  PromptCommandHookSchema,
  BashCommandHookSchema,
  ProcessCommandHookSchema,
  HttpHookSchema,
  AgentHookSchema,
]);

export type HookCommand = z.infer<typeof HookCommandSchema>;
export type PromptCommandHook = Extract<HookCommand, { type: 'prompt' }>;
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>;
export type ProcessCommandHook = Extract<HookCommand, { type: 'process' }>;
export type HttpHook = Extract<HookCommand, { type: 'http' }>;
export type AgentHook = Extract<HookCommand, { type: 'agent' }>;

/**
 * Plan 437: `agent_progress` sub-type emitted once per matched hook after
 * `ConfigHooksRunner` finishes a dispatch. Carries the data the chat-flow
 * hook row needs to render its collapsed chrome (icon + verb + hook name +
 * duration + status) and its expanded card (additionalContext / verifier
 * diagnostic / error message / async task id).
 *
 * Wire shape is intentionally flat so the existing `chat:agent_progress`
 * envelope passes through without further mapping — the renderer picks it
 * up via `handleAgentProgressEvent` and unwraps the same way it unwraps
 * sub-agent progress events today.
 */
export interface HookInvokedEvent {
  type: 'hook_invoked';
  /** Hook lifecycle event that fired (e.g. `PreToolUse`, `PostToolUse`). */
  hookEventName: HookEvent;
  /** Matched hook executor type. */
  hookType: HookCommand['type'];
  /** Human-readable hook identifier — `hookCommandLine(hook)`, capped. */
  hookName: string;
  /** Matcher pattern that fired (e.g. `"Bash"`). Undefined when matcher omitted. */
  matcher?: string;
  /** additionalContext returned to the agent (or empty for verifier-only). */
  additionalContext?: string;
  /** Non-zero exit code when a verifier hook ran with problems. */
  exitCode?: number;
  /** True for `async: true` command hooks that returned a background task id. */
  async: boolean;
  /** Background task id (only set when async === true). */
  backgroundTaskId?: string;
  /** Wall-clock duration of the hook execution in ms. */
  durationMs: number;
  /** Outcome of the dispatch. */
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  /** Reason when status is not 'ok' (always present for non-ok statuses). */
  errorMessage?: string;
  /** Per-dispatch sequence so the renderer can order hooks fired in the same turn. */
  seq: number;
  /** Tool name when the event is tool-scoped (PreToolUse / PostToolUse / ...). */
  toolName?: string;
  /** Associated tool_use_id when tool-scoped. */
  toolUseId?: string;
}

/**
 * Hook matcher configuration
 */
export const HookMatcherSchema = z.object({
  matcher: z.string().optional().describe('String pattern to match (e.g. tool names)'),
  hooks: z.array(HookCommandSchema).describe('List of hooks to execute'),
});

export type HookMatcher = z.infer<typeof HookMatcherSchema>;

/**
 * Hooks configuration (partial record of hook events to matchers)
 */
export const HooksSettingsSchema = z.object({
  PreToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUseFailure: z.array(HookMatcherSchema).optional(),
  Notification: z.array(HookMatcherSchema).optional(),
  UserPromptSubmit: z.array(HookMatcherSchema).optional(),
  SessionStart: z.array(HookMatcherSchema).optional(),
  SessionEnd: z.array(HookMatcherSchema).optional(),
  Setup: z.array(HookMatcherSchema).optional(),
  SubagentStart: z.array(HookMatcherSchema).optional(),
  SubagentStop: z.array(HookMatcherSchema).optional(),
  PermissionDenied: z.array(HookMatcherSchema).optional(),
  PermissionRequest: z.array(HookMatcherSchema).optional(),
  Elicitation: z.array(HookMatcherSchema).optional(),
  ElicitationResult: z.array(HookMatcherSchema).optional(),
  CwdChanged: z.array(HookMatcherSchema).optional(),
  FileChanged: z.array(HookMatcherSchema).optional(),
  WorktreeCreate: z.array(HookMatcherSchema).optional(),
  WorktreeRemove: z.array(HookMatcherSchema).optional(),
  PreCompact: z.array(HookMatcherSchema).optional(),
  PostCompact: z.array(HookMatcherSchema).optional(),
  PreTurn: z.array(HookMatcherSchema).optional(),
  PostTurn: z.array(HookMatcherSchema).optional(),
  PreFinalize: z.array(HookMatcherSchema).optional(),
  Stop: z.array(HookMatcherSchema).optional(),
  StopFailure: z.array(HookMatcherSchema).optional(),
  TeammateIdle: z.array(HookMatcherSchema).optional(),
  TaskCreated: z.array(HookMatcherSchema).optional(),
  TaskCompleted: z.array(HookMatcherSchema).optional(),
  ConfigChange: z.array(HookMatcherSchema).optional(),
  InstructionsLoaded: z.array(HookMatcherSchema).optional(),
});

export type HooksSettings = z.infer<typeof HooksSettingsSchema>;

// ============================================================================
// Hook Result Types
// ============================================================================

/**
 * Permission request result
 */
export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: Array<{
        type: string
        rules?: Array<{ toolName: string; ruleContent?: string }>
        behavior?: 'allow' | 'deny' | 'ask'
        destination?: string
      }>
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    };

/**
 * Hook execution result
 */
export interface HookResult {
  message?: string
  systemMessage?: string
  blockingError?: {
    blockingError: string
    command: string
  }
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }
  watchPaths?: string[]
  elicitationResultResponse?: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }
  retry?: boolean
  hook: HookCommand | FunctionHook
}

/**
 * Aggregated hook result from multiple hooks
 */
export type AggregatedHookResult = {
  message?: string
  blockingError?: { blockingError: string; command: string }
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: 'allow' | 'deny' | 'ask' | 'passthrough'
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  watchPaths?: string[]
  elicitationResponse?: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }
  elicitationResultResponse?: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }
  retry?: boolean
};

// ============================================================================
// Function Hook Types (in-memory callbacks)
// ============================================================================

/**
 * Function hook callback type - returns true if check passes, false to block
 */
export type FunctionHookCallback = (
  input: HookInput,
  toolUseID: string | null,
  signal?: AbortSignal,
) => boolean | Promise<boolean>;

/**
 * Function hook type with callback embedded
 * Session-scoped only, cannot be persisted to settings
 */
export interface FunctionHook {
  type: 'function'
  id?: string
  timeout?: number
  callback: FunctionHookCallback
  errorMessage: string
  statusMessage?: string
}

// ============================================================================
// Session Hook Types (internal to hooks system)
// ============================================================================

// SessionHookMatcher and SessionHooksState are defined in utils/sessionHooks.ts

// ============================================================================
// ${VAR} template expansion (ZCode hooks.json alignment)
// ============================================================================

/**
 * Expansion values must only contain characters safe for a single command
 * argument / path: alphanumerics plus `_ . / : -` and the Windows path
 * separator `\`. Anything else (spaces, quotes, `$`, backticks, `;`) is
 * rejected and the placeholder is left untouched — a hostile or malformed
 * var can never inject shell syntax (the process executor spawns without
 * a shell, so this is defense in depth rather than the primary boundary).
 */
export const HOOK_VAR_SAFE_RE = /^[a-zA-Z0-9_./:\\-]+$/;

/**
 * Expand `${KEY}` placeholders in a hook command / argument using `vars`.
 *
 * - Only `[A-Za-z_][A-Za-z0-9_]*` keys are recognized.
 * - Unknown keys (e.g. `${ZCODE_PLUGIN_ROOT}` when the caller did not
 *   provide it) are left verbatim so the hook script can resolve them
 *   itself.
 * - Values that fail {@link HOOK_VAR_SAFE_RE} are skipped (placeholder
 *   kept) rather than substituted.
 */
export function expandHookTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined || !HOOK_VAR_SAFE_RE.test(value)) return match;
    return value;
  });
}

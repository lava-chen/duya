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
  'Setup',
  'SubagentStart',
  'PermissionDenied',
  'PermissionRequest',
  'Elicitation',
  'ElicitationResult',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
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
  SetupHookInputSchema,
  SubagentStartHookInputSchema,
  PermissionRequestHookInputSchema,
  ElicitationHookInputSchema,
  ElicitationResultHookInputSchema,
  CwdChangedHookInputSchema,
  FileChangedHookInputSchema,
  WorktreeCreateHookInputSchema,
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
  BashCommandHookSchema,
  HttpHookSchema,
  AgentHookSchema,
]);

export type HookCommand = z.infer<typeof HookCommandSchema>;
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>;
export type HttpHook = Extract<HookCommand, { type: 'http' }>;
export type AgentHook = Extract<HookCommand, { type: 'agent' }>;

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
  Setup: z.array(HookMatcherSchema).optional(),
  SubagentStart: z.array(HookMatcherSchema).optional(),
  PermissionDenied: z.array(HookMatcherSchema).optional(),
  PermissionRequest: z.array(HookMatcherSchema).optional(),
  Elicitation: z.array(HookMatcherSchema).optional(),
  ElicitationResult: z.array(HookMatcherSchema).optional(),
  CwdChanged: z.array(HookMatcherSchema).optional(),
  FileChanged: z.array(HookMatcherSchema).optional(),
  WorktreeCreate: z.array(HookMatcherSchema).optional(),
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

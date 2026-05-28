/**
 * Hook execution utilities for duya Agent
 *
 * Adapted from claude-code-haha/src/utils/hooks.ts
 * Provides core hook execution functionality.
 */

import { randomUUID } from 'crypto';
import type {
  HookEvent,
  HookCommand,
  HookInput,
  HookResult,
  AggregatedHookResult,
  HookMatcher,
  FunctionHook,
  PermissionRequestResult,
} from '../types.js';
import { HookJSONOutputSchema } from '../types.js';
import { getSessionHooks, getSessionFunctionHooks } from './sessionHooks.js';
import { getPrioritizedMatches, matchesMatcher } from '../matcher.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOOK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Types
// ============================================================================

interface HookExecutionContext {
  sessionId: string;
  cwd: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
}

interface HookExecutorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ============================================================================
// Hook Input Creation
// ============================================================================

/**
 * Create base hook input common to all hook types
 */
export function createBaseHookInput(
  context: HookExecutionContext,
): {
  session_id: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
} {
  return {
    session_id: context.sessionId,
    cwd: context.cwd,
    permission_mode: context.permissionMode,
    agent_id: context.agentId,
    agent_type: context.agentType,
  };
}

/**
 * Create PreToolUse hook input
 */
export function createPreToolUseHookInput(
  context: HookExecutionContext,
  params: { tool_name: string; tool_input: unknown; tool_use_id: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PreToolUse',
    tool_name: params.tool_name,
    tool_input: params.tool_input,
    tool_use_id: params.tool_use_id,
  };
}

/**
 * Create PostToolUse hook input
 */
export function createPostToolUseHookInput(
  context: HookExecutionContext,
  params: { tool_name: string; tool_input: unknown; tool_response: unknown; tool_use_id: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PostToolUse',
    tool_name: params.tool_name,
    tool_input: params.tool_input,
    tool_response: params.tool_response,
    tool_use_id: params.tool_use_id,
  };
}

/**
 * Create PostToolUseFailure hook input
 */
export function createPostToolUseFailureHookInput(
  context: HookExecutionContext,
  params: { tool_name: string; tool_input: unknown; tool_use_id: string; error: string; is_interrupt?: boolean },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PostToolUseFailure',
    tool_name: params.tool_name,
    tool_input: params.tool_input,
    tool_use_id: params.tool_use_id,
    error: params.error,
    is_interrupt: params.is_interrupt,
  };
}

/**
 * Create UserPromptSubmit hook input
 */
export function createUserPromptSubmitHookInput(
  context: HookExecutionContext,
  params: { prompt: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'UserPromptSubmit',
    prompt: params.prompt,
  };
}

/**
 * Create SessionStart hook input
 */
export function createSessionStartHookInput(
  context: HookExecutionContext,
  params: { source: 'startup' | 'resume' | 'clear' | 'compact' },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'SessionStart',
    source: params.source,
  };
}

/**
 * Create Setup hook input
 */
export function createSetupHookInput(
  context: HookExecutionContext,
  params: { trigger: 'init' | 'maintenance' },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'Setup',
    trigger: params.trigger,
  };
}

/**
 * Create SubagentStart hook input
 */
export function createSubagentStartHookInput(
  context: HookExecutionContext,
  params: { agent_id: string; agent_type: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'SubagentStart',
    agent_id: params.agent_id,
    agent_type: params.agent_type,
  };
}

/**
 * Create Notification hook input
 */
export function createNotificationHookInput(
  context: HookExecutionContext,
  params: { message: string; title?: string; notification_type: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'Notification',
    message: params.message,
    title: params.title,
    notification_type: params.notification_type,
  };
}

/**
 * Create PermissionDenied hook input
 */
export function createPermissionDeniedHookInput(
  context: HookExecutionContext,
  params: { tool_name: string; tool_input: unknown; tool_use_id: string; reason: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PermissionDenied',
    tool_name: params.tool_name,
    tool_input: params.tool_input,
    tool_use_id: params.tool_use_id,
    reason: params.reason,
  };
}

/**
 * Create PermissionRequest hook input
 */
export function createPermissionRequestHookInput(
  context: HookExecutionContext,
  params: { tool_name: string; tool_input: unknown },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PermissionRequest',
    tool_name: params.tool_name,
    tool_input: params.tool_input,
  };
}

/**
 * Create CwdChanged hook input
 */
export function createCwdChangedHookInput(
  context: HookExecutionContext,
  params: { old_cwd: string; new_cwd: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'CwdChanged',
    old_cwd: params.old_cwd,
    new_cwd: params.new_cwd,
  };
}

/**
 * Create FileChanged hook input
 */
export function createFileChangedHookInput(
  context: HookExecutionContext,
  params: { file_path: string; event: 'change' | 'add' | 'unlink' },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'FileChanged',
    file_path: params.file_path,
    event: params.event,
  };
}

/**
 * Create WorktreeCreate hook input
 */
export function createWorktreeCreateHookInput(
  context: HookExecutionContext,
  params: { name: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'WorktreeCreate',
    name: params.name,
  };
}

/**
 * Create WorktreeRemove hook input
 */
export function createWorktreeRemoveHookInput(
  context: HookExecutionContext,
  params: { name: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'WorktreeRemove',
    name: params.name,
  };
}

/**
 * Create SessionEnd hook input
 */
export function createSessionEndHookInput(
  context: HookExecutionContext,
  params: { reason?: 'user_exit' | 'timeout' | 'error' | 'clear' },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'SessionEnd',
    reason: params.reason,
  };
}

/**
 * Create PreCompact hook input
 */
export function createPreCompactHookInput(
  context: HookExecutionContext,
  params: { trigger: 'auto' | 'manual' | 'idle'; compactConfig?: Record<string, unknown> },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PreCompact',
    trigger: params.trigger,
    compactConfig: params.compactConfig,
  };
}

/**
 * Create PostCompact hook input
 */
export function createPostCompactHookInput(
  context: HookExecutionContext,
  params: { trigger: 'auto' | 'manual' | 'idle'; messageCountBefore?: number; messageCountAfter?: number; error?: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'PostCompact',
    trigger: params.trigger,
    messageCountBefore: params.messageCountBefore,
    messageCountAfter: params.messageCountAfter,
    error: params.error,
  };
}

/**
 * Create Stop hook input
 */
export function createStopHookInput(
  context: HookExecutionContext,
  params: { reason: 'user_request' | 'system' | 'error' | 'timeout' },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'Stop',
    reason: params.reason,
  };
}

/**
 * Create StopFailure hook input
 */
export function createStopFailureHookInput(
  context: HookExecutionContext,
  params: { reason: 'user_request' | 'system' | 'error' | 'timeout'; error: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'StopFailure',
    reason: params.reason,
    error: params.error,
  };
}

/**
 * Create SubagentStop hook input
 */
export function createSubagentStopHookInput(
  context: HookExecutionContext,
  params: { agent_id: string; agent_type: string; status: 'completed' | 'error' | 'cancelled' | 'timeout'; summary?: string; error?: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'SubagentStop',
    agent_id: params.agent_id,
    agent_type: params.agent_type,
    status: params.status,
    summary: params.summary,
    error: params.error,
  };
}

/**
 * Create TeammateIdle hook input
 */
export function createTeammateIdleHookInput(
  context: HookExecutionContext,
  params: { agent_id: string; agent_type: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'TeammateIdle',
    agent_id: params.agent_id,
    agent_type: params.agent_type,
  };
}

/**
 * Create TaskCreated hook input
 */
export function createTaskCreatedHookInput(
  context: HookExecutionContext,
  params: { task_id: string; task_name: string; task_context?: Record<string, unknown> },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'TaskCreated',
    task_id: params.task_id,
    task_name: params.task_name,
    task_context: params.task_context,
  };
}

/**
 * Create TaskCompleted hook input
 */
export function createTaskCompletedHookInput(
  context: HookExecutionContext,
  params: { task_id: string; task_name: string; status: 'completed' | 'failed' | 'cancelled'; result?: string; error?: string },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'TaskCompleted',
    task_id: params.task_id,
    task_name: params.task_name,
    status: params.status,
    result: params.result,
    error: params.error,
  };
}

/**
 * Create ConfigChange hook input
 */
export function createConfigChangeHookInput(
  context: HookExecutionContext,
  params: { changed_keys: string[]; old_values?: Record<string, unknown>; new_values?: Record<string, unknown> },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'ConfigChange',
    changed_keys: params.changed_keys,
    old_values: params.old_values,
    new_values: params.new_values,
  };
}

/**
 * Create InstructionsLoaded hook input
 */
export function createInstructionsLoadedHookInput(
  context: HookExecutionContext,
  params: { instruction_source: string; instruction_count?: number },
): HookInput {
  return {
    ...createBaseHookInput(context),
    hook_event_name: 'InstructionsLoaded',
    instruction_source: params.instruction_source,
    instruction_count: params.instruction_count,
  };
}

// ============================================================================
// Hook Execution
// ============================================================================

/**
 * Parse and validate a JSON string against the hook output Zod schema
 */
function validateHookJson(jsonString: string): { json: unknown } | { validationError: string } {
  try {
    const parsed = JSON.parse(jsonString);
    const validation = HookJSONOutputSchema.safeParse(parsed);
    if (validation.success) {
      return { json: validation.data };
    }
    const errors = validation.error.issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((err: any) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    return {
      validationError: `Hook JSON output validation failed:\n${errors}`,
    };
  } catch (e: unknown) {
    return { validationError: `Failed to parse hook output as JSON: ${e}` };
  }
}

/**
 * Process hook JSON output into a HookResult
 */
function processHookJSONOutput(
  json: unknown,
  command: string,
  toolUseID: string,
  hookEvent: HookEvent,
): Partial<HookResult> {
  const result: Partial<HookResult> = {};
  const syncJson = json as Record<string, unknown>;

  // Handle continue field
  if (syncJson.continue === false) {
    result.preventContinuation = true;
    if (syncJson.stopReason) {
      result.stopReason = String(syncJson.stopReason);
    }
  }

  // Handle decision field
  if (syncJson.decision) {
    switch (syncJson.decision) {
      case 'approve':
        result.permissionBehavior = 'allow';
        break;
      case 'block':
        result.permissionBehavior = 'deny';
        result.blockingError = {
          blockingError: String(syncJson.reason) || 'Blocked by hook',
          command,
        };
        break;
    }
  }

  // Handle systemMessage field
  if (syncJson.systemMessage) {
    result.systemMessage = String(syncJson.systemMessage);
  }

  // Handle hookSpecificOutput
  const hookSpecificOutput = syncJson.hookSpecificOutput as Record<string, unknown> | undefined;
  if (hookSpecificOutput) {
    switch (hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        if (hookSpecificOutput.permissionDecision) {
          switch (hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow';
              break;
            case 'deny':
              result.permissionBehavior = 'deny';
              result.blockingError = {
                blockingError: String(hookSpecificOutput.permissionDecisionReason || syncJson.reason) || 'Blocked by hook',
                command,
              };
              break;
            case 'ask':
              result.permissionBehavior = 'ask';
              break;
          }
        }
        if (hookSpecificOutput.updatedInput) {
          result.updatedInput = hookSpecificOutput.updatedInput as Record<string, unknown>;
        }
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'UserPromptSubmit':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'SessionStart':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        result.initialUserMessage = hookSpecificOutput.initialUserMessage as string | undefined;
        if (hookSpecificOutput.watchPaths) {
          result.watchPaths = hookSpecificOutput.watchPaths as string[];
        }
        break;

      case 'Setup':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'SubagentStart':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'PostToolUse':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        if (hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput = hookSpecificOutput.updatedMCPToolOutput;
        }
        break;

      case 'PostToolUseFailure':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'PermissionDenied':
        result.retry = Boolean(hookSpecificOutput.retry);
        break;

      case 'PermissionRequest':
        if (hookSpecificOutput.decision) {
          const decision = hookSpecificOutput.decision as Record<string, unknown>;
          result.permissionRequestResult = decision as PermissionRequestResult;
          result.permissionBehavior = decision.behavior === 'allow' ? 'allow' : 'deny';
          if (decision.behavior === 'allow' && decision.updatedInput) {
            result.updatedInput = decision.updatedInput as Record<string, unknown>;
          }
        }
        break;

      case 'CwdChanged':
        if (hookSpecificOutput.watchPaths) {
          result.watchPaths = hookSpecificOutput.watchPaths as string[];
        }
        break;

      case 'FileChanged':
        if (hookSpecificOutput.watchPaths) {
          result.watchPaths = hookSpecificOutput.watchPaths as string[];
        }
        break;

      case 'SessionEnd':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'PreCompact':
        if (hookSpecificOutput.permissionDecision === 'deny') {
          result.preventContinuation = true;
          result.stopReason = String(hookSpecificOutput.permissionDecisionReason || 'Blocked by PreCompact hook');
          result.blockingError = {
            blockingError: result.stopReason,
            command,
          };
        }
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'PostCompact':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'Stop':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'StopFailure':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'SubagentStop':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'TeammateIdle':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'TaskCreated':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'TaskCompleted':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'ConfigChange':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'InstructionsLoaded':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'WorktreeRemove':
        result.additionalContext = hookSpecificOutput.additionalContext as string | undefined;
        break;

      case 'Elicitation':
        if (hookSpecificOutput.elicitationResponse) {
          result.elicitationResponse = hookSpecificOutput.elicitationResponse as {
            action: 'accept' | 'decline' | 'cancel';
            content?: Record<string, unknown>;
          };
        }
        break;

      case 'ElicitationResult':
        if (hookSpecificOutput.elicitationResultResponse) {
          result.elicitationResultResponse = hookSpecificOutput.elicitationResultResponse as {
            action: 'accept' | 'decline' | 'cancel';
            content?: Record<string, unknown>;
          };
        }
        break;
    }
  }

  return result;
}

// ============================================================================
// Command Hook Executor
// ============================================================================

interface CommandHookResult {
  stdout: string;
  stderr: string;
  output: string;
  status: number;
  aborted?: boolean;
}

/**
 * Execute a bash command hook
 */
export async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  jsonInput: string,
  options: HookExecutorOptions = {},
): Promise<CommandHookResult> {
  const { spawn } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify((await import('child_process')).exec);

  const timeoutMs = hook.timeout ? hook.timeout * 1000 : (options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
  const shellType = hook.shell ?? 'bash';

  // Build the command
  const command = hook.command;

  // Set up environment variables
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_HOOK_INPUT: jsonInput,
  };

  // CLAUDE_ENV_FILE for session start hooks
  if (['SessionStart', 'Setup', 'CwdChanged', 'FileChanged'].includes(hook.type)) {
    // Would set CLAUDE_ENV_FILE here if we had the session environment system
  }

  try {
    const execOptions: {
      timeout?: number;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      shell?: string;
      cwd?: string;
    } = {
      timeout: timeoutMs,
      signal: options.signal,
      env,
    };

    if (shellType === 'powershell') {
      execOptions.shell = 'pwsh';
    }

    const result = await execAsync(command, execOptions);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execResult = result as any;
    return {
      stdout: execResult.stdout ?? '',
      stderr: execResult.stderr ?? '',
      output: (execResult.stdout ?? '') + (execResult.stderr ?? ''),
      status: execResult.status ?? 0,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: -1,
        aborted: true,
      };
    }
    if ((error as { code?: string }).code === 'ETIMEDOUT') {
      return {
        stdout: '',
        stderr: 'Hook timed out',
        output: 'Hook timed out',
        status: -1,
      };
    }
    throw error;
  }
}

/**
 * Execute a hook and return the result
 */
export async function executeHook(
  hook: HookCommand,
  hookEvent: HookEvent,
  hookInput: HookInput,
  options: HookExecutorOptions = {},
): Promise<HookResult> {
  const jsonInput = JSON.stringify(hookInput);
  const toolUseID = (hookInput as { tool_use_id?: string }).tool_use_id ?? `hook-${randomUUID()}`;

  try {
    if (hook.type === 'command') {
      const result = await execCommandHook(hook, jsonInput, options);

      if (result.aborted) {
        return { outcome: 'cancelled', hook };
      }

      const trimmed = result.stdout.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        const processed = processHookJSONOutput(parsed, hook.command, toolUseID, hookEvent);
        return {
          ...processed,
          outcome: result.status === 0 ? 'success' : result.status === 2 ? 'blocking' : 'non_blocking_error',
          hook,
        };
      }

      return {
        outcome: result.status === 0 ? 'success' : result.status === 2 ? 'blocking' : 'non_blocking_error',
        hook,
      };
    }

    if (hook.type === 'prompt') {
      const { executePromptHook } = await import('../executors/prompt-executor.js');
      const result = await executePromptHook(hook, jsonInput, options);
      return {
        ...result,
        hook,
      };
    }

    if (hook.type === 'http') {
      const { executeHttpHook } = await import('../executors/http-executor.js');
      const result = await executeHttpHook(hook, jsonInput, options);
      return {
        ...result,
        hook,
      };
    }

    if (hook.type === 'agent') {
      const { executeAgentHook } = await import('../executors/agent-executor.js');
      const result = await executeAgentHook(hook, jsonInput, options);
      return {
        ...result,
        hook,
      };
    }

    return {
      outcome: 'non_blocking_error',
      hook,
    };
  } catch (error) {
    return {
      outcome: 'non_blocking_error',
      hook,
    };
  }
}

// ============================================================================
// Aggregate Hook Results
// ============================================================================

/**
 * Aggregate multiple hook results into a single result
 */
export function aggregateHookResults(results: HookResult[]): AggregatedHookResult {
  const aggregated: AggregatedHookResult = {};

  for (const result of results) {
    // Collect blocking errors
    if (result.blockingError) {
      aggregated.blockingError = result.blockingError;
    }

    // Merge permission behaviors (last one wins for deny/allow)
    if (result.permissionBehavior) {
      aggregated.permissionBehavior = result.permissionBehavior;
    }

    // Collect additional contexts
    if (result.additionalContext) {
      aggregated.additionalContexts = aggregated.additionalContexts ?? [];
      aggregated.additionalContexts.push(result.additionalContext);
    }

    // Collect other fields
    if (result.initialUserMessage) {
      aggregated.initialUserMessage = result.initialUserMessage;
    }
    if (result.updatedInput) {
      aggregated.updatedInput = result.updatedInput;
    }
    if (result.updatedMCPToolOutput) {
      aggregated.updatedMCPToolOutput = result.updatedMCPToolOutput;
    }
    if (result.permissionRequestResult) {
      aggregated.permissionRequestResult = result.permissionRequestResult;
    }
    if (result.watchPaths) {
      aggregated.watchPaths = aggregated.watchPaths ?? [];
      aggregated.watchPaths.push(...result.watchPaths);
    }
    if (result.elicitationResponse) {
      aggregated.elicitationResponse = result.elicitationResponse;
    }
    if (result.elicitationResultResponse) {
      aggregated.elicitationResultResponse = result.elicitationResultResponse;
    }
    if (result.retry !== undefined) {
      aggregated.retry = result.retry;
    }
  }

  // Determine final outcome
  if (aggregated.blockingError) {
    aggregated.preventContinuation = true;
    aggregated.stopReason = aggregated.blockingError.blockingError;
  }

  return aggregated;
}

// ============================================================================
// Hook Matching (Enhanced)
// ============================================================================

/**
 * Get matching hooks for a given hook event and input.
 * Uses the enhanced matcher with glob pattern and priority sorting.
 */
export function getMatchingHooks(
  sessionId: string,
  hookEvent: HookEvent,
  input: Record<string, unknown>,
  permissionContext: Record<string, unknown> = {},
): HookCommand[] {
  const hooks: HookCommand[] = [];
  const sessionHooks = getSessionHooks(sessionId, hookEvent);

  const matchers = sessionHooks.get(hookEvent);
  if (!matchers || matchers.length === 0) return hooks;

  const hookMatchers: HookMatcher[] = matchers.map(m => ({
    matcher: m.matcher,
    hooks: m.hooks.map(h => h.hook as HookCommand & { type: 'command' | 'prompt' | 'http' | 'agent' }),
  }));

  const prioritized = getPrioritizedMatches(hookMatchers, input, permissionContext);

  for (const matcherConfig of prioritized) {
    for (const hookEntry of matcherConfig.hooks) {
      hooks.push(hookEntry as HookCommand);
    }
  }

  return hooks;
}

/**
 * Execute all matching hooks for a given hook event and input.
 * Supports async hooks: hooks with async: true are spawned in background.
 */
export async function executeHooksForEvent(
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  options: HookExecutorOptions = {},
): Promise<AggregatedHookResult> {
  const input = hookInput as unknown as Record<string, unknown>;
  const hooks = getMatchingHooks(sessionId, hookEvent, input);

  const results: HookResult[] = [];

  for (const hook of hooks) {
    // Check if this is an async hook
    if ('async' in hook && hook.async === true) {
      const asyncTimeout = ('asyncTimeout' in hook && typeof hook.asyncTimeout === 'number')
        ? hook.asyncTimeout * 1000
        : (hook.timeout ? hook.timeout * 1000 : undefined);

      const { spawnAsyncHook } = await import('../executors/async-runner.js');
      spawnAsyncHook(
        `async-${hookEvent}-${Date.now()}-${Math.random()}`,
        hook,
        hookEvent,
        hookInput,
        asyncTimeout || 10 * 60 * 1000,
        options,
      );
      continue;
    }

    const result = await executeHook(hook, hookEvent, hookInput, options);
    results.push(result);

    if (result.outcome === 'blocking') {
      break;
    }
  }

  // Also execute function hooks
  const functionHooks = getSessionFunctionHooks(sessionId, hookEvent);
  const functionMatchers = functionHooks.get(hookEvent);
  if (functionMatchers) {
    for (const matcherConfig of functionMatchers) {
      const matchResult = matchesMatcher(matcherConfig.matcher, input);
      if (matchResult.matches) {
        for (const funcHook of matcherConfig.hooks) {
          try {
            const passed = await funcHook.callback(hookInput, (hookInput as { tool_use_id?: string }).tool_use_id ?? null, options.signal);
            if (!passed) {
              results.push({
                outcome: 'blocking',
                hook: funcHook,
              });
              break;
            }
          } catch {
            // Function hooks don't block on error
          }
        }
      }
    }
  }

  return aggregateHookResults(results);
}

// Re-export session hook functions
export {
  addSessionHook,
  addFunctionHook,
  removeFunctionHook,
  removeSessionHook,
  getSessionHooks,
  getSessionFunctionHooks,
  clearSessionHooks,
} from './sessionHooks.js';

/**
 * BashTool - Simplified shell command execution tool
 * Direct spawn, no Worker, no Docker sandbox, no complex background system.
 *
 * Every command is started as a managed background task (see managed-bash.ts);
 * the tool call only decides how long to wait for it:
 *   - `run_in_background: true` → return the task id immediately (unbounded)
 *   - foreground                 → wait up to BASH_SOFT_YIELD_MS, then hand the
 *     still-running task back to the model instead of blocking the conversation
 *     until the hard timeout. The child process is never restarted.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import type { ToolExecutor } from '../registry.js';
import { moveToRecycleBin, parsePlainRmCommand } from './safe-rm.js';
import { BaseTool } from '../BaseTool.js';
import { UNKNOWN_PATHS, type ToolDependencyDeclaration } from '../dependencies.js';
import type {
  ToolContext,
  ToolValidationResult,
  PermissionCheckResult,
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import { detectShellForFamily, type ShellInfo } from '../../utils/shellDetector.js';
import { getBashOutputDir } from '../../utils/duyaRoot.js';
import { normalizeShellCommandForExecution } from '../../utils/shell/intelligence.js';
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_SOFT_YIELD_MS,
} from './constants.js';
import { buildGitReminder } from './git-reminder.js';
import { startManagedBash, type ManagedBashCompletion, type ManagedBashHandle } from './managed-bash.js';
import { raceCompletionWithSoftYield } from './soft-yield.js';
import { GET_TASK_OUTPUT_TOOL_NAME } from '../BackgroundTaskTool/GetTaskOutputTool.js';
import { analyzeCommandSafety, isReadOnlyCommand } from '../../permissions/policy.js';
import type { SecurityCheckResult, SecurityWarning } from '../../permissions/policy.js';
import { isBypassMode } from '../../permissions/policy.js';
import { wrapPowerShellCommand, encodePowerShellCommand, buildExtglobGuard } from '../../utils/shell/providers.js';

// ============================================================================
// Windows Encoding Fix
// ============================================================================

/**
 * Force UTF-8 encoding on Windows to fix Chinese output garbling.
 */
function getWindowsEncodingEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {};
  return {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}

// ============================================================================
// Output Truncation
// ============================================================================

export const BASH_MAX_OUTPUT_CHARS = 30_000;
export const BASH_MAX_OUTPUT_LINES = 1_000;

export interface TruncatedShellOutput {
  output: string;
  fullOutputPath?: string;
}

export function truncateShellOutput(content: string): TruncatedShellOutput {
  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  const tooLarge = trimmed.length > BASH_MAX_OUTPUT_CHARS || lines.length > BASH_MAX_OUTPUT_LINES;
  if (!tooLarge) return { output: trimmed };

  const totalBytes = Buffer.byteLength(trimmed, 'utf8');
  const totalLines = lines.length;
  let fullOutputPath: string | undefined;
  try {
    fullOutputPath = join(getBashOutputDir(), `duya-bash-full-${crypto.randomUUID()}.log`);
    writeFileSync(fullOutputPath, trimmed, 'utf8');
  } catch {
    fullOutputPath = undefined;
  }

  // Keep the tail (errors/final results live at the end)
  let tail = trimmed.slice(-BASH_MAX_OUTPUT_CHARS);
  const newlineIdx = tail.indexOf('\n');
  if (newlineIdx > 0) tail = tail.slice(newlineIdx + 1);

  const sizeHint = `${(totalBytes / 1024).toFixed(1)}KB`;
  const fullHint = fullOutputPath
    ? `Full output saved to: ${fullOutputPath}\nUse read("${fullOutputPath}") to read the full output.`
    : 'Full output was too large to spill to disk.';
  const marker =
    `\n\n[Output truncated: showing last ${tail.length.toLocaleString()} of ` +
    `${totalLines.toLocaleString()} lines / ${sizeHint} total. ${fullHint}]`;

  return { output: tail + marker, fullOutputPath };
}

// ============================================================================
// Environment
// ============================================================================

export function buildSanitizedBashEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...getWindowsEncodingEnv(),
  };
  const sensitivePattern = /TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL/i;
  for (const key of Object.keys(env)) {
    if (sensitivePattern.test(key)) {
      delete env[key];
    }
  }
  return env;
}

// ============================================================================
// Types & Config
// ============================================================================

export interface BashToolInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  background?: boolean;
}

export interface ShellCommandToolConfig {
  name: string;
  description: string;
  providerKind: 'bash' | 'powershell';
  commandLabel: string;
  securityCheck?: (command: string) => SecurityCheckResult;
  readOnlyCheck?: (command: string) => boolean;
  normalizeCommandForExecution?: (command: string) => string;
  /**
   * How long a foreground call waits before yielding a still-running command to
   * the background. Defaults to {@link BASH_SOFT_YIELD_MS}; `0` disables
   * yielding (strictly foreground behavior) and is used by tests.
   */
  softYieldMs?: number;
}

const DEFAULT_BASH_TOOL_CONFIG: ShellCommandToolConfig = {
  name: 'bash',
  description:
    'Execute a bash command and return its stdout + stderr output. ' +
    'Quote arguments correctly: single quotes (\'...\') prevent all expansion, ' +
    'double quotes ("...") allow variable and backtick expansion. ' +
    `A foreground command that outlives ${BASH_SOFT_YIELD_MS}ms is handed off to a ` +
    'background task without restarting it and you are given its task id — do not re-run it. ' +
    'For known long-running commands, set run_in_background=true and you will be notified on completion.',
  providerKind: 'bash',
  commandLabel: 'bash command',
  securityCheck: analyzeCommandSafety,
  readOnlyCheck: isReadOnlyCommand,
  normalizeCommandForExecution: (command) => normalizeShellCommandForExecution('bash', command),
};

// ============================================================================
// Input Validation
// ============================================================================

export function validateBashInput(input: unknown): { valid: true; data: BashToolInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.command || typeof obj.command !== 'string') {
    return { valid: false, error: 'command must be a string' };
  }

  if (obj.command.trim().length === 0) {
    return { valid: false, error: 'command cannot be empty' };
  }

  if (obj.timeout !== undefined) {
    if (typeof obj.timeout !== 'number' || obj.timeout <= 0) {
      return { valid: false, error: 'timeout must be a positive number' };
    }
    const maxAllowed = (obj.run_in_background || obj.background)
      ? BASH_MAX_TIMEOUT_MS
      : BASH_MAX_FOREGROUND_TIMEOUT_MS;
    if (obj.timeout > maxAllowed) {
      return {
        valid: false,
        error: `timeout cannot exceed ${maxAllowed}ms`,
      };
    }
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    return { valid: false, error: 'description must be a string' };
  }

  if (obj.run_in_background !== undefined && typeof obj.run_in_background !== 'boolean') {
    return { valid: false, error: 'run_in_background must be a boolean' };
  }

  if (obj.background !== undefined && typeof obj.background !== 'boolean') {
    return { valid: false, error: 'background must be a boolean' };
  }

  return {
    valid: true,
    data: {
      command: obj.command as string,
      timeout: obj.timeout as number | undefined,
      description: obj.description as string | undefined,
      run_in_background: obj.run_in_background as boolean | undefined,
      background: obj.run_in_background ?? (obj.background as boolean | undefined),
    },
  };
}

// ============================================================================
// Shell Resolution
// ============================================================================

function getShellUnavailableMessage(providerKind: 'bash' | 'powershell'): string {
  if (providerKind === 'bash') {
    return process.platform === 'win32'
      ? 'Bash tool requires Git Bash, MSYS2, or Cygwin. No compatible shell was detected.'
      : 'Bash tool requires a Unix-compatible shell, but none was detected.';
  }
  return process.platform === 'win32'
    ? 'PowerShell tool requires PowerShell (pwsh or Windows PowerShell), but none was detected.'
    : 'PowerShell tool requires pwsh, but it is not installed or not in PATH.';
}

function resolveShellInfo(providerKind: 'bash' | 'powershell'): ShellInfo | null {
  return detectShellForFamily(providerKind === 'bash' ? 'unix' : 'powershell');
}

function buildShellArgs(providerKind: 'bash' | 'powershell', shellInfo: ShellInfo, command: string): string[] {
  if (providerKind === 'powershell') {
    const wrapped = wrapPowerShellCommand(command);
    return [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShellCommand(wrapped),
    ];
  }
  // bash/zsh
  return [
    shellInfo.execArg,
    `${buildExtglobGuard(shellInfo.name)}; ${command}`,
  ];
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class BashTool extends BaseTool implements ToolExecutor {
  private readonly config: ShellCommandToolConfig;

  constructor(config: Partial<ShellCommandToolConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BASH_TOOL_CONFIG, ...config };
  }

  get name(): string { return this.config.name; }
  get description(): string { return this.config.description; }

  get input_schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `The ${this.config.commandLabel} to execute`,
        },
        timeout: {
          type: 'number',
          description:
            `How long a foreground call waits before yielding, in milliseconds. ` +
            `Default: ${BASH_DEFAULT_TIMEOUT_MS}, max: ${BASH_MAX_FOREGROUND_TIMEOUT_MS} for foreground, ` +
            `${BASH_MAX_TIMEOUT_MS} for background. A foreground command still running after ` +
            `${BASH_SOFT_YIELD_MS}ms is auto-promoted to a background task (no restart): the call returns ` +
            'its task id and you are notified when it finishes.',
        },
        description: {
          type: 'string',
          description: 'Optional description for the command',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Start in background and return a task id immediately.',
        },
        background: {
          type: 'boolean',
          description: 'Deprecated alias for run_in_background.',
        },
      },
      required: ['command'],
    };
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  readonly dependencies: ToolDependencyDeclaration = Object.freeze({
    readPaths: [...UNKNOWN_PATHS],
    writePaths: [...UNKNOWN_PATHS],
    requires: [],
    produces: [],
    consumes: [],
  });

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const validation = validateBashInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { command, timeout } = validation.data;
    const resolvedTimeout = timeout ?? BASH_DEFAULT_TIMEOUT_MS;
    const cwd = workingDirectory || process.cwd();
    const isBackground = validation.data.run_in_background === true || validation.data.background === true;

    // Plan 554: a plain top-level `rm` on Windows recycles instead of
    // unlinking, so an over-eager deletion stays recoverable. Anything
    // compound (shell operators, globs) or non-Windows runs through the
    // shell unchanged — see safe-rm.ts for the conservative interception
    // rules.
    if (process.platform === 'win32') {
      const plainRm = parsePlainRmCommand(command);
      if (plainRm) {
        const outcome = await moveToRecycleBin(plainRm.targets, cwd);
        const lines: string[] = [];
        if (outcome.trashed.length > 0) {
          lines.push(`Moved ${outcome.trashed.length} path(s) to the Recycle Bin (recoverable):`);
          for (const p of outcome.trashed) lines.push(`  - ${p}`);
        }
        if (outcome.missing.length > 0) {
          lines.push('Not found (left unchanged):');
          for (const p of outcome.missing) lines.push(`  - ${p}`);
        }
        for (const f of outcome.failed) {
          lines.push(`Failed to recycle ${f.path}: ${f.error}`);
        }
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: lines.join('\n') || 'rm: nothing to delete',
          error: outcome.failed.length > 0,
          metadata: {
            safeRm: true,
            trashed: outcome.trashed.length,
            failed: outcome.failed.length,
          },
        };
      }
    }

    // Resolve shell
    const shellInfo = resolveShellInfo(this.config.providerKind);
    if (!shellInfo) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: getShellUnavailableMessage(this.config.providerKind),
        error: true,
      };
    }

    // Normalize command
    const normalizedCommand = this.config.normalizeCommandForExecution
      ? this.config.normalizeCommandForExecution(command)
      : normalizeShellCommandForExecution(this.config.providerKind, command);

    const taskId = context?.toolUseId ?? crypto.randomUUID();
    const shellArgs = buildShellArgs(this.config.providerKind, shellInfo, normalizedCommand);

    // Explicit background: start the managed task and return its id immediately.
    if (isBackground) {
      return this.startDetached({ taskId, command, shellInfo, shellArgs, cwd, context });
    }

    // Foreground: start the task, then race its completion against the soft-yield
    // window. Starting first (rather than execa-ing in the foreground and
    // re-running on timeout) is what makes the hand-off free: the process is
    // live before the race, so yielding only stops *waiting*, never the command.
    let handle: ManagedBashHandle;
    try {
      handle = await startManagedBash({
        taskId,
        command,
        shellPath: shellInfo.path,
        shellArgs,
        cwd,
        env: buildSanitizedBashEnv(),
        foregroundTimeoutMs: resolvedTimeout,
        sessionId: context?.options.sessionId,
        abortSignal: context?.abortController?.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Failed to start command: ${message}`,
        error: true,
      };
    }

    const completion = await raceCompletionWithSoftYield(handle.settled, this.softYieldMs);

    // Soft yield: the command outlived the wait window. Hand the task back and
    // let it keep running under the background ceiling.
    if (!completion) {
      handle.promoteToBackground();
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          `Command still running after ${this.softYieldMs}ms — handed off to background task ${handle.taskId} (PID: ${handle.pid}) without restarting it.`,
          `Output file: ${handle.outputFile}`,
          'You will be notified automatically when it finishes. Do NOT re-run this command.',
          `Use ${GET_TASK_OUTPUT_TOOL_NAME} for a status/output snapshot (never blocks) and kill_task to stop it.`,
          `It is terminated automatically after ${BASH_MAX_TIMEOUT_MS}ms if it has not finished by then.`,
        ].join('\n'),
        metadata: {
          autoPromoted: true,
          taskId: handle.taskId,
          pid: handle.pid,
          outputFile: handle.outputFile,
          softYieldMs: this.softYieldMs,
        },
      };
    }

    return this.buildForegroundResult({ completion, command, outputFile: handle.outputFile, timeoutMs: resolvedTimeout, shellInfo });
  }

  /** Soft-yield window used by this tool; `0` disables yielding. */
  private get softYieldMs(): number {
    return this.config.softYieldMs ?? BASH_SOFT_YIELD_MS;
  }

  /**
   * Build the tool result for a command that finished inside the wait window.
   * Mirrors the historical execa-path shape (output + git reminder + bounded
   * output) so the model-facing contract is unchanged for fast commands.
   */
  private buildForegroundResult(params: {
    completion: ManagedBashCompletion;
    command: string;
    outputFile: string;
    timeoutMs: number;
    shellInfo: ShellInfo;
  }): ToolResult {
    const { completion, command, outputFile, timeoutMs, shellInfo } = params;
    const base = { id: crypto.randomUUID(), name: this.name };

    if (completion.status === 'timeout') {
      const output = completion.text ? `\n\n${completion.text}` : '';
      return {
        ...base,
        result: `Command timed out (${timeoutMs}ms): ${command}${output}`,
        error: true,
        metadata: { timeout: true, durationMs: completion.durationMs, taskId: completion.taskId, outputFile },
      };
    }

    if (completion.status === 'canceled') {
      return {
        ...base,
        result: `Command was cancelled: ${completion.text || '(no output)'}`,
        error: true,
        metadata: { cancelled: true, taskId: completion.taskId, outputFile },
      };
    }

    let output = completion.text || completion.error || '';

    // Provide helpful error context for Windows users
    if (process.platform === 'win32' && completion.exitCode !== 0) {
      const isCommandNotFound = output.includes('is not recognized') ||
        output.includes('not found') ||
        output.includes('not internal or external command');
      if (isCommandNotFound) {
        const looksUnixSpecific = /\b(cat|head|tail|ls|grep|sed|awk|curl|wget|touch|chmod|chown|rm|cp|mv)\b|\/dev\/null|~\//.test(command);
        if (looksUnixSpecific && !shellInfo.supportsUnixCommands) {
          output = `${output}\n\n[Note] The current shell (${shellInfo.name}) does not support Unix commands. Consider installing Git Bash for Windows.`;
        }
      }
    }

    const gitReminder = buildGitReminder(command);
    if (gitReminder) output = `${output}\n\n${gitReminder}`;

    const { output: boundedOutput, fullOutputPath } = truncateShellOutput(output);
    return {
      ...base,
      result: boundedOutput || '(no output)',
      error: completion.status !== 'completed',
      metadata: {
        exitCode: completion.exitCode,
        durationMs: completion.durationMs,
        taskId: completion.taskId,
        outputFile,
        ...(fullOutputPath ? { fullOutputPath } : {}),
      },
    };
  }

  /**
   * Explicit `run_in_background`: register the task and return immediately.
   * Unbounded by design (see constants.ts) — no watchdog is armed.
   */
  private async startDetached(params: {
    taskId: string;
    command: string;
    shellInfo: ShellInfo;
    shellArgs: string[];
    cwd: string;
    context?: ToolUseContext;
  }): Promise<ToolResult> {
    const { taskId, command, shellInfo, shellArgs, cwd, context } = params;

    try {
      const handle = await startManagedBash({
        taskId,
        command,
        shellPath: shellInfo.path,
        shellArgs,
        cwd,
        env: buildSanitizedBashEnv(),
        foregroundTimeoutMs: null,
        sessionId: context?.options.sessionId,
        abortSignal: context?.abortController?.signal,
      });

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          `Background process started (PID: ${handle.pid})`,
          `Output file: ${handle.outputFile}`,
          'You will be notified automatically when it completes.',
          `Use ${GET_TASK_OUTPUT_TOOL_NAME} for status/output snapshot (never blocks).`,
        ].join('\n'),
        metadata: {
          backgrounded: true,
          taskId: handle.taskId,
          pid: handle.pid,
          outputFile: handle.outputFile,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Failed to start background command: ${message}`,
        error: true,
      };
    }
  }

  cancel(): void {
    // No-op: cancellation handled via abort signal in execute
  }

  validateInput(input: unknown): ToolValidationResult {
    const result = validateBashInput(input);
    if (!result.valid) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result.data };
  }

  checkPermissions(input: unknown, context: ToolContext): PermissionCheckResult {
    const validated = validateBashInput(input);
    if (!validated.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }

    const { command } = validated.data;
    const appState = context.getAppState();
    const permissionContext = appState?.toolPermissionContext as ToolPermissionContext | undefined;

    const securityResult = (this.config.securityCheck ?? analyzeCommandSafety)(command);

    // Critical severity = never bypass
    const hasCritical = securityResult.warnings.some(w => w.severity === 'critical');
    if (hasCritical) {
      return {
        allowed: false,
        reason: 'Command is catastrophically dangerous and cannot be executed',
      };
    }

    // Bypass mode: skip soft confirmation
    if (permissionContext && isBypassMode(permissionContext.mode)) {
      return { allowed: true };
    }

    // Soft warnings require user confirmation
    if (!securityResult.safe || securityResult.requiresApproval) {
      return {
        allowed: true,
        requiresUserConfirmation: true,
        reason: securityResult.warnings.map(w => w.message).join('; '),
      };
    }

    return { allowed: true };
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    const exitCode = result.metadata?.exitCode as number | undefined;

    let output = result.result;
    if (exitCode !== undefined && exitCode !== 0) {
      output = `[Exit code: ${exitCode}]\n${output}`;
    }

    return {
      type: 'text',
      content: output,
      metadata: result.metadata,
    };
  }

  renderToolUsePendingMessage(): RenderedToolMessage {
    return {
      type: 'text',
      content: 'Waiting for command execution...',
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj.command as string | undefined;
      if (cmd) {
        const preview = cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
        return `${this.name}: ${preview}`;
      }
    }
    return this.name;
  }
}

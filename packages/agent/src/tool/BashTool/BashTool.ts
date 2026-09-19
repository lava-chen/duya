/**
 * BashTool - Simplified shell command execution tool
 * ~250 lines: direct execa/spawn, no Worker, no Docker sandbox, no complex background system
 */

import { execa, ExecaError } from 'execa';
import { spawn, type ChildProcess } from 'child_process';
import { open, readFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import type { ToolExecutor } from '../registry.js';
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
import { killProcessTree } from '../../utils/processTreeKill.js';
import { normalizeShellCommandForExecution } from '../../utils/shell/intelligence.js';
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
} from './constants.js';
import { buildGitReminder } from './git-reminder.js';
import { getBashTaskRegistry } from '../../session/bash-task-registry.js';
import { buildTaskNotificationXml } from '../../lifecycle/buildTaskNotification.js';
import { sendBackgroundNotification } from '../../lifecycle/mailboxBackgroundNotification.js';
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
}

const DEFAULT_BASH_TOOL_CONFIG: ShellCommandToolConfig = {
  name: 'bash',
  description:
    'Execute a bash command and return its stdout + stderr output. ' +
    'Quote arguments correctly: single quotes (\'...\') prevent all expansion, ' +
    'double quotes ("...") allow variable and backtick expansion. ' +
    'For long-running commands, set run_in_background=true and you will be notified on completion.',
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
  constructor(
    private readonly config: ShellCommandToolConfig = DEFAULT_BASH_TOOL_CONFIG,
  ) {
    super();
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
          description: `Timeout in milliseconds. Default: ${BASH_DEFAULT_TIMEOUT_MS}, max: ${BASH_MAX_FOREGROUND_TIMEOUT_MS} for foreground, ${BASH_MAX_TIMEOUT_MS} for background.`,
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

    // Background execution path
    if (isBackground) {
      return this.executeBackground({
        command: normalizedCommand,
        originalCommand: command,
        shellInfo,
        cwd,
        timeout: resolvedTimeout,
        toolUseId: context?.toolUseId ?? crypto.randomUUID(),
        sessionId: context?.options.sessionId,
        abortSignal: context?.abortController?.signal,
      });
    }

    // Foreground execution with execa
    try {
      const shellArgs = buildShellArgs(this.config.providerKind, shellInfo, normalizedCommand);
      const result = await execa(shellInfo.path, shellArgs, {
        cwd,
        env: buildSanitizedBashEnv(),
        timeout: resolvedTimeout,
        windowsHide: true,
        cleanup: true,
      });

      let output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      const gitReminder = buildGitReminder(command);
      if (gitReminder) output = `${output}\n\n${gitReminder}`;

      const { output: boundedOutput, fullOutputPath } = truncateShellOutput(output);
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: boundedOutput || '(no output)',
        error: result.exitCode !== 0,
        metadata: {
          exitCode: result.exitCode,
          ...(fullOutputPath ? { fullOutputPath } : {}),
        },
      };
    } catch (error: unknown) {
      if (error instanceof ExecaError) {
        const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();

        if (error.timedOut) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: `Command timed out (${resolvedTimeout}ms): ${command}\n\n${output}`,
            error: true,
            metadata: { timeout: true, durationMs: resolvedTimeout },
          };
        }

        if (error.isCanceled) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: `Command was cancelled: ${output || error.message}`,
            error: true,
            metadata: { cancelled: true },
          };
        }

        // Provide helpful error context for Windows users
        let finalOutput = output || error.message;
        if (process.platform === 'win32' && error.exitCode !== 0) {
          const isCommandNotFound = output.includes('is not recognized') ||
            output.includes('not found') ||
            output.includes('not internal or external command');
          if (isCommandNotFound) {
            const looksUnixSpecific = /\b(cat|head|tail|ls|grep|sed|awk|curl|wget|touch|chmod|chown|rm|cp|mv)\b|\/dev\/null|~\//.test(command);
            if (looksUnixSpecific && !shellInfo.supportsUnixCommands) {
              finalOutput = `${finalOutput}\n\n[Note] The current shell (${shellInfo.name}) does not support Unix commands. Consider installing Git Bash for Windows.`;
            }
          }
        }

        const gitReminder = buildGitReminder(command);
        if (gitReminder) finalOutput = `${finalOutput}\n\n${gitReminder}`;

        const { output: boundedError, fullOutputPath } = truncateShellOutput(finalOutput);
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: boundedError,
          error: true,
          metadata: {
            exitCode: error.exitCode,
            ...(fullOutputPath ? { fullOutputPath } : {}),
          },
        };
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: error instanceof Error ? error.message : 'Unknown error',
        error: true,
      };
    }
  }

  private async executeBackground(params: {
    command: string;
    originalCommand: string;
    shellInfo: ShellInfo;
    cwd: string;
    timeout: number;
    toolUseId: string;
    sessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<ToolResult> {
    const { command, originalCommand, shellInfo, cwd, timeout, toolUseId, sessionId, abortSignal } = params;
    const outputFile = join(getBashOutputDir(), `duya-bash-${toolUseId}.log`);

    try {
      const fd = await open(outputFile, 'w', 0o644);
      const shellArgs = buildShellArgs(this.config.providerKind, shellInfo, command);

      const proc = spawn(shellInfo.path, shellArgs, {
        cwd,
        env: buildSanitizedBashEnv(),
        stdio: ['ignore', fd.fd, fd.fd],
        windowsHide: true,
      });

      proc.unref();
      const startTime = Date.now();
      const pid = proc.pid ?? -1;

      // Register task
      const registry = getBashTaskRegistry();
      registry.register({
        id: toolUseId,
        pid,
        outputFile,
        command: originalCommand.slice(0, 200),
        status: 'running',
        startTime,
      });

      // Handle completion
      proc.on('close', (exitCode) => {
        registry.markCompleted(toolUseId, exitCode ?? -1);
        void fd.close().catch(() => { /* already closed */ });

        if (!sessionId) return;

        const status = exitCode === 0 ? 'completed' : 'failed';
        const xml = buildTaskNotificationXml({
          taskId: toolUseId,
          status,
          agentType: 'bash',
          agentName: originalCommand.slice(0, 200),
          description: originalCommand.slice(0, 200),
          outputFilePath: outputFile,
          finalMessage: `Background command completed with exit code ${exitCode ?? -1}.`,
        });
        void sendBackgroundNotification({ sessionId, xml, taskId: toolUseId });
      });

      proc.on('error', (err) => {
        registry.markCompleted(toolUseId, -1, err.message);
        void fd.close().catch(() => { /* already closed */ });
      });

      // Abort handling
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (pid) void killProcessTree(pid);
        }, { once: true });
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          `Background process started (PID: ${pid})`,
          `Output file: ${outputFile}`,
          `You will be notified automatically when it completes.`,
          `Use ${GET_TASK_OUTPUT_TOOL_NAME} for status/output snapshot (never blocks).`,
        ].join('\n'),
        metadata: {
          backgrounded: true,
          pid,
          outputFile,
          taskId: toolUseId,
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

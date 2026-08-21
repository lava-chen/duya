/**
 * BashTool - Enhanced shell command execution tool
 * Adds input validation, security checks, and permission hints
 */

import { execa, ExecaError, type Options } from 'execa';
import { spawn } from 'child_process';
import { open } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import type { ToolExecutor } from '../registry.js';
import { BaseTool } from '../BaseTool.js';
import type {
  ToolContext,
  ToolValidationResult,
  PermissionCheckResult,
  RenderedToolMessage,
  ToolProgress,
  ToolInterruptBehavior,
} from '../types.js';
import { SandboxManager, getActiveProvider, executeIsolated, wrapCommand } from '../../sandbox/index.js';
import { resolveShellProvider, type ShellProviderKind } from '../../utils/shell/providers.js';
import { killProcessTree } from '../../utils/processTreeKill.js';
import {
  analyzeShellFailure,
  normalizeShellCommandForExecution,
  resolveShellExecutionPlan,
} from '../../utils/shell/intelligence.js';
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from './constants.js';
import { getBashTaskRegistry } from '../../session/bash-task-registry.js';
import { buildTaskNotificationXml } from '../../lifecycle/buildTaskNotification.js';
import { sendBackgroundNotification } from '../../lifecycle/mailboxBackgroundNotification.js';
import { GET_TASK_OUTPUT_TOOL_NAME } from '../BackgroundTaskTool/GetTaskOutputTool.js';
import {
  analyzeCommandSafety,
  isReadOnlyCommand,
} from '../../permissions/policy.js';
import type {
  SecurityCheckResult,
  SecurityWarning,
} from '../../permissions/policy.js';
import { isBypassMode } from '../../permissions/policy.js';

// ============================================================================
// Windows Encoding & Path Fixes
// ============================================================================

/**
 * Returns environment variables to force UTF-8 encoding on Windows.
 * Fixes Python print() Chinese garbled output and echo Chinese file corruption.
 *
 * - PYTHONIOENCODING=utf-8: Force Python stdout/stderr to UTF-8
 * - PYTHONUTF8=1: Python 3.7+ PEP 540 UTF-8 mode
 * - LANG/LC_ALL: Force shell and subprocesses to UTF-8 locale
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

// ============================================================
// Output Truncation
// ============================================================

/**
 * Shell output is unbounded by nature (a single `find`/`ls`/build can emit
 * hundreds of KB). Feeding it straight into the tool result both bloats the
 * persisted rollout and, more importantly, floods the CURRENT model context
 * (projection offload only trims historical messages). Root fix: cap the
 * output at the tool boundary — keep a readable tail, spill the full output to
 * a temp file, and tell the model where it is so it can read more on demand.
 */
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
    fullOutputPath = join(tmpdir(), `duya-bash-full-${crypto.randomUUID()}.log`);
    writeFileSync(fullOutputPath, trimmed, 'utf8');
  } catch {
    fullOutputPath = undefined;
  }

  // Keep the tail (errors / final results live at the end). Prefer a line-aligned
  // tail when the char budget allows, otherwise slice the char tail.
  let tail = trimmed.slice(-BASH_MAX_OUTPUT_CHARS);
  const newlineIdx = tail.indexOf('\n');
  if (newlineIdx > 0) tail = tail.slice(newlineIdx + 1); // drop a partial first line

  const sizeHint = `${(totalBytes / 1024).toFixed(1)}KB`;
  const fullHint = fullOutputPath
    ? `Full output saved to: ${fullOutputPath}\nUse read("${fullOutputPath}") to read the full output.`
    : 'Full output was too large to spill to disk.';
  const marker =
    `\n\n[Output truncated: showing last ${tail.length.toLocaleString()} of ` +
    `${totalLines.toLocaleString()} lines / ${sizeHint} total. ${fullHint}]`;

  return { output: tail + marker, fullOutputPath };
}

// ============================================================
// Input Validation
// ============================================================

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
  providerKind: ShellProviderKind;
  commandLabel: string;
  securityCheck?: (command: string) => SecurityCheckResult;
  readOnlyCheck?: (command: string) => boolean;
  normalizeCommandForExecution?: (command: string) => string;
}

const DEFAULT_BASH_TOOL_CONFIG: ShellCommandToolConfig = {
  name: 'bash',
  description:
    'Execute a bash command and return its stdout + stderr output. ' +
    'Quote arguments correctly: single quotes (\'...\') prevent all expansion (no variables or backticks), ' +
    'double quotes ("...") allow variable and backtick expansion; prefer a single one-line command chained with && or ; over multi-line scripts. ' +
    'For commands that emit very long output, pipe through head/grep/sed/tail or redirect to a file instead of dumping everything to the transcript. ' +
    'Do not use bash as a thinking scratchpad or pad with empty echo commands — blank output only wastes turns; reason in your own scratchpad instead. ' +
    'For long-running commands, set run_in_background=true and you will be notified on completion; use get_task_output with the returned task ID to fetch results, and kill_task to terminate a background task if needed.',
  providerKind: 'bash',
  commandLabel: 'bash command',
  securityCheck: analyzeCommandSafety,
  readOnlyCheck: isReadOnlyCommand,
  normalizeCommandForExecution: (command) => normalizeShellCommandForExecution('bash', command),
};

/**
 * Validates BashTool input
 */
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
    if (obj.timeout > BASH_MAX_TIMEOUT_MS) {
      return { valid: false, error: `timeout cannot exceed ${BASH_MAX_TIMEOUT_MS}ms (${BASH_MAX_TIMEOUT_MS / 60000} minutes)` };
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

  const runInBackground = obj.run_in_background as boolean | undefined;
  const legacyBackground = obj.background as boolean | undefined;

  return {
    valid: true,
    data: {
      command: obj.command as string,
      timeout: obj.timeout as number | undefined,
      description: obj.description as string | undefined,
      run_in_background: runInBackground,
      background: runInBackground ?? legacyBackground,
    },
  };
}

function getShellUnavailableMessage(providerKind: ShellProviderKind): string {
  if (providerKind === 'bash') {
    return process.platform === 'win32'
      ? 'Bash tool requires a Unix-compatible shell such as Git Bash, MSYS2, or Cygwin. No compatible shell was detected.'
      : 'Bash tool requires a Unix-compatible shell, but none was detected.';
  }

  return process.platform === 'win32'
    ? 'PowerShell tool requires PowerShell (pwsh or Windows PowerShell), but none was detected.'
    : 'PowerShell tool requires pwsh, but it is not installed or not in PATH.';
}

// ============================================================
// Tool Implementation
// ============================================================

export class BashTool extends BaseTool implements ToolExecutor {
  constructor(
    private readonly config: ShellCommandToolConfig = DEFAULT_BASH_TOOL_CONFIG,
  ) {
    super();
  }

  get name(): string {
    return this.config.name;
  }

  get description(): string {
    return this.config.description;
  }

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
          description: `Timeout in milliseconds (default: ${BASH_DEFAULT_TIMEOUT_MS}, max: ${BASH_MAX_TIMEOUT_MS})`,
        },
        description: {
          type: 'string',
          description: 'Optional description for the command',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Whether to run the command in the background',
        },
        background: {
          type: 'boolean',
          description: 'Deprecated alias for run_in_background. Prefer run_in_background.',
        },
      },
      required: ['command'],
    };
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  private defaultTimeout = BASH_DEFAULT_TIMEOUT_MS;
  private killed = false;

  isConcurrencySafe(): boolean {
    return false;
  }

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
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
    const resolvedTimeout = timeout ?? this.defaultTimeout;

    // Security analysis for display purposes only — permission decisions
    // are handled by the central hasPermissionsToUseTool flow before
    // execute() is called.
    const securityResult = (this.config.securityCheck ?? analyzeCommandSafety)(command);

    const executionPlan = resolveShellExecutionPlan(this.config.providerKind, command);
    if (!executionPlan.provider || !executionPlan.providerKind) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: getShellUnavailableMessage(this.config.providerKind),
        error: true,
      };
    }

    const shellProvider = executionPlan.provider;
    const shellInfo = shellProvider.shellInfo;
    // Fall back to process.cwd() for local execution when no project is set.
    // Docker sandbox is skipped below when workingDirectory is absent because
    // mounting process.cwd() (often the app install dir) is never useful.
    const cwd = workingDirectory || process.cwd();

    const normalizedCommand = executionPlan.reroutedFrom
      ? normalizeShellCommandForExecution(executionPlan.providerKind, command)
      : (this.config.normalizeCommandForExecution
        ? this.config.normalizeCommandForExecution(command)
        : normalizeShellCommandForExecution(executionPlan.providerKind, command));

    // Background execution path: spawn a detached process, redirect output
    // to a temp file, register in BashTaskRegistry, and return immediately.
    // The process keeps running after execute() resolves; completion is
    // reported later via a background_notification mailbox so the LLM can resume.
    const isBackground =
      validation.data.run_in_background === true ||
      validation.data.background === true;
    if (isBackground) {
      return this.executeBackground({
        command: normalizedCommand,
        originalCommand: command,
        shellProvider,
        shellInfo,
        cwd,
        timeout: resolvedTimeout,
        toolUseId: context?.toolUseId ?? crypto.randomUUID(),
        sessionId: context?.options.sessionId,
        securityWarnings: securityResult.warnings,
        executionPlanReason: executionPlan.reason,
      });
    }

    try {
      const provider = await getActiveProvider();

      // Docker execution path — full isolation.
      // Only enter when workingDirectory is set: mounting process.cwd()
      // (the app install dir in packaged builds) would expose unrelated
      // files and break path translation inside the container.
      if (provider === 'docker' && shellInfo.family === 'unix' && workingDirectory) {
        try {
          const sandboxResult = await executeIsolated(
            normalizedCommand,
            workingDirectory,
            {
              filesystem: {
                allowRead: [],
                // workingDirectory is guaranteed non-empty by the outer if.
                allowWrite: [workingDirectory],
                denyWrite: ['/etc', '/sys', '/proc', '/dev'],
              },
            },
            context?.abortController?.signal,
            resolvedTimeout,
          );

          if (sandboxResult.timedOut) {
            return {
              id: crypto.randomUUID(),
              name: this.name,
              result: `Command timed out (${resolvedTimeout}ms): ${command}\n\n${sandboxResult.stdout}`,
              error: true,
              metadata: {
                timeout: true,
                exitCode: sandboxResult.exitCode,
                durationMs: resolvedTimeout,
                sandboxed: true,
                provider: 'docker',
              },
            };
          }

          const output = [sandboxResult.stdout, sandboxResult.stderr]
            .filter(Boolean)
            .join('\n')
            .trim();

          const nonCriticalWarnings = securityResult.warnings.filter(
            w => w.severity !== 'critical' && w.severity !== 'high'
          );

          let resultOutput = output || '(no output)';
          if (nonCriticalWarnings.length > 0) {
            const warningMsg = `[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`;
            resultOutput = `${warningMsg}\n\n${resultOutput}`;
          }
          const { output: boundedResult, fullOutputPath: dockerFullPath } = truncateShellOutput(resultOutput);

          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: boundedResult,
            error: sandboxResult.exitCode !== 0,
            metadata: {
              exitCode: sandboxResult.exitCode,
              sandboxed: true,
              provider: 'docker',
              ...(dockerFullPath ? { fullOutputPath: dockerFullPath } : {}),
            },
          };
        } catch (dockerError) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: dockerError instanceof Error ? dockerError.message : 'Docker sandbox error',
            error: true,
            metadata: { sandboxed: true, provider: 'docker' },
          };
        }
      }

      // Non-Docker path: wrap command (bubblewrap or none) then execa
      const finalCommand = await wrapCommand(normalizedCommand, cwd);

      const sanitizedEnv = {
        ...process.env,
        ...getWindowsEncodingEnv(),
      };
      // Match env var names containing sensitive tokens so we catch keys
      // the previous hard-coded list missed (GITHUB_TOKEN, GITLAB_TOKEN,
      // AWS_SECRET_ACCESS_KEY, PRIVATE_KEY, PASSPHRASE, ...). The regex
      // runs against the var NAME, not its value.
      const sensitivePattern = /TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL/i;
      for (const key of Object.keys(sanitizedEnv)) {
        if (sensitivePattern.test(key)) {
          delete sanitizedEnv[key];
        }
      }

      const options: Options = {
        timeout: resolvedTimeout,
        env: sanitizedEnv,
        preferLocal: true,
        cwd: workingDirectory,
        cancelSignal: context?.abortController?.signal,
      };

      const nonCriticalWarnings = securityResult.warnings.filter(
        w => w.severity !== 'critical' && w.severity !== 'high'
      );

      // execa's default kill only terminates the direct shell child.
      // On Windows that is `TerminateProcess(pid)` — it does NOT reach
      // bash's grandchildren (cargo / rustc / link.exe / MSYS2 subshells),
      // which then run as orphans holding file handles and keeping the
      // foreground tool call from truly ending. Wire up our own
      // process-tree kill that runs alongside execa's default. On Unix,
      // bash was not spawned with `detached: true` so we fall back to
      // SIGKILL on the direct PID — still better than execa's no-op when
      // the child has already been replaced by another shell layer.
      const subprocess = execa(
        shellInfo.path,
        shellProvider.buildArgs(finalCommand),
        options,
      );
      const treeKillAbort = () => {
        const pid = subprocess.pid;
        if (pid) {
          void killProcessTree(pid);
        }
      };
      context?.abortController?.signal.addEventListener('abort', treeKillAbort, { once: true });

      let result;
      try {
        result = await subprocess;
      } catch (err) {
        // Belt-and-suspenders: if execa reported the child as gone but the
        // tree is still alive (Windows MSYS2 / cargo chain), make sure
        // we tear it down before propagating.
        treeKillAbort();
        throw err;
      } finally {
        context?.abortController?.signal.removeEventListener('abort', treeKillAbort);
      }

      let output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      if (nonCriticalWarnings.length > 0) {
        const warningMsg = `[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`;
        output = `${warningMsg}\n\n${output}`;
      }

      if (executionPlan.reason) {
        output = `[Shell] ${executionPlan.reason}\n\n${output}`;
      }

      const { output: boundedOutput, fullOutputPath } = truncateShellOutput(output);
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: boundedOutput || '(no output)',
        metadata: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          ...(fullOutputPath ? { fullOutputPath } : {}),
        },
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: `Command was cancelled: ${command}`,
          error: true,
          metadata: { cancelled: true },
        };
      }

      if (error instanceof ExecaError) {
        const output = [error.stdout, error.stderr]
          .filter(Boolean)
          .join('\n')
          .trim();

        if (error.timedOut) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: `Command timed out (${resolvedTimeout}ms): ${command}\n\n${output}`,
            error: true,
            metadata: { timeout: true, durationMs: resolvedTimeout },
          };
        }

        if (this.killed) {
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
        const failureAnalysis = analyzeShellFailure({
          providerKind: executionPlan.providerKind,
          command: normalizedCommand,
          error: error.message,
          output,
          exitCode: error.exitCode,
        });
        if (process.platform === 'win32' && error.exitCode !== 0) {
          const isCommandNotFound = output.includes('is not recognized') ||
            output.includes('not found') ||
            output.includes('not internal or external command');
          if (isCommandNotFound) {
            const looksUnixSpecific =
              /\b(cat|head|tail|ls|grep|sed|awk|curl|wget|touch|chmod|chown|rm|cp|mv)\b|\/dev\/null|~\//.test(command);
            if (looksUnixSpecific && !shellInfo.supportsUnixCommands) {
              finalOutput = `${finalOutput}\n\n[Note] The current shell (${shellInfo.name}) does not support Unix commands. ` +
                `Consider installing Git Bash for Windows to enable Unix command compatibility.`;
            }
          }
        }

        if (failureAnalysis.hints.length > 0) {
          finalOutput = `${finalOutput}\n\nHints:\n- ${failureAnalysis.hints.join('\n- ')}`;
        }

        const { output: boundedError, fullOutputPath: errFullPath } = truncateShellOutput(finalOutput);
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: boundedError,
          error: true,
          metadata: {
            exitCode: error.exitCode,
            ...(errFullPath ? { fullOutputPath: errFullPath } : {}),
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

  /**
   * Execute a command in the background.
   *
   * Spawns a detached child process whose stdout/stderr are redirected to a
   * temp file, registers it in BashTaskRegistry so the UI can list/inspect
   * it, and returns immediately. When the process exits, the close handler
   * marks the task complete and enqueues a notification so the LLM can
   * resume the conversation with the final exit code.
   *
   * This replaces the previous WorkerPool-backed background path. Unlike
   * the worker pool, each background command spawns its own shell and
   * releases it on exit — there is no long-running BashWorker process.
   */
  private async executeBackground(params: {
    command: string;
    originalCommand: string;
    shellProvider: NonNullable<ReturnType<typeof resolveShellProvider>>;
    shellInfo: import('../../utils/shellDetector.js').ShellInfo;
    cwd: string;
    timeout: number;
    toolUseId: string;
    sessionId?: string;
    securityWarnings: SecurityWarning[];
    executionPlanReason?: string;
  }): Promise<ToolResult> {
    const {
      command,
      originalCommand,
      shellProvider,
      shellInfo,
      cwd,
      toolUseId,
      sessionId,
      securityWarnings,
      executionPlanReason,
    } = params;

    const outputFile = join(tmpdir(), `duya-bash-${toolUseId}.log`);

    try {
      const fd = await open(outputFile, 'w', 0o644);

      // Sanitize environment: strip sensitive vars and force UTF-8 on Windows.
      const sanitizedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...getWindowsEncodingEnv(),
      };
      const sensitivePattern = /TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL/i;
      for (const key of Object.keys(sanitizedEnv)) {
        if (sensitivePattern.test(key)) {
          delete sanitizedEnv[key];
        }
      }

      const shellArgs = shellProvider.buildArgs(command);
      const proc = spawn(shellInfo.path, shellArgs, {
        cwd,
        env: sanitizedEnv,
        stdio: ['ignore', fd.fd, fd.fd],
        windowsHide: true,
      });

      // Detach so this process does not keep the agent alive.
      proc.unref();

      const startTime = Date.now();
      const pid = proc.pid ?? -1;

      // Register immediately so the UI shows the running task.
      const registry = getBashTaskRegistry();
      registry.register({
        id: toolUseId,
        pid,
        outputFile,
        command: originalCommand.slice(0, 200),
        status: 'running',
        startTime,
      });

      // close handler: mark complete and notify the parent conversation.
      proc.on('close', (exitCode) => {
        registry.markCompleted(toolUseId, exitCode ?? -1);
        void fd.close().catch(() => { /* already closed */ });

        if (!sessionId) return;

        const completedTask = registry.getTask(toolUseId);
        const status = exitCode === 0 ? 'completed' : 'failed';
        const finalMessage = `Background command completed with exit code ${exitCode ?? -1}.`;
        const xml = buildTaskNotificationXml({
          taskId: toolUseId,
          status,
          agentType: 'bash',
          agentName: originalCommand.slice(0, 200),
          description: originalCommand.slice(0, 200),
          outputFilePath: outputFile,
          finalMessage,
          totalDurationMs: completedTask?.endTime && completedTask?.startTime
            ? completedTask.endTime - completedTask.startTime
            : undefined,
        });
        void sendBackgroundNotification({
          sessionId,
          xml,
          taskId: toolUseId,
        });
      });

      proc.on('error', (err) => {
        registry.markCompleted(toolUseId, -1, err.message);
        void fd.close().catch(() => { /* already closed */ });
      });

      const nonCriticalWarnings = securityWarnings.filter(
        w => w.severity !== 'critical' && w.severity !== 'high',
      );

      const lines: string[] = [];
      if (executionPlanReason) lines.push(`[Shell] ${executionPlanReason}`);
      if (nonCriticalWarnings.length > 0) {
        lines.push(`[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`);
      }
      lines.push(`Background process started (PID: ${pid})`);
      lines.push(`Output file: ${outputFile}`);
      lines.push(`You will be notified automatically when it completes. Do not wait or poll for it.`);
      lines.push(`Use ${GET_TASK_OUTPUT_TOOL_NAME} only for a quick status snapshot (no timeout_ms).`);

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: lines.join('\n'),
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
    this.killed = true;
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

    // Use the configured security check (bash or powershell patterns).
    const securityResult = (this.config.securityCheck ?? analyzeCommandSafety)(command);

    // Critical severity = catastrophic, NEVER bypassed even in bypass mode.
    // This is defense-in-depth: the central isCatastrophicToolCall already
    // catches bash catastrophic commands before the bypass short-circuit,
    // but this also catches tool-specific catastrophic patterns (e.g.
    // PowerShell Invoke-Expression) that the central check doesn't know about.
    const hasCritical = securityResult.warnings.some(w => w.severity === 'critical');
    if (hasCritical) {
      return {
        allowed: false,
        reason: 'Command is catastrophically dangerous and cannot be executed',
      };
    }

    // Bypass mode: skip soft confirmation prompts.
    if (permissionContext && isBypassMode(permissionContext.mode)) {
      return { allowed: true };
    }

    // Soft warnings require user confirmation in normal mode.
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
    const durationMs = result.metadata?.durationMs as number | undefined;

    let output = result.result;
    if (durationMs !== undefined) {
      output = `[Completed in ${durationMs}ms]\n${output}`;
    }
    if (exitCode !== undefined && exitCode !== 0) {
      output = `[Exit code: ${exitCode}]\n${output}`;
    }

    const lines = result.result.split('\n').length;
    if (lines > 50) {
      const preview = result.result.split('\n').slice(0, 20).join('\n');
      return {
        type: 'code',
        content: `${output}\n\n[Output truncated: ${lines - 20} more lines not shown. Use a more specific command or redirect to a file to see the full output.]`,
        metadata: { ...result.metadata, lineCount: lines, truncated: true },
      };
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

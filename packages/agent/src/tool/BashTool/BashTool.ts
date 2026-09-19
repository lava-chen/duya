/**
 * BashTool - Enhanced shell command execution tool
 * Adds input validation, security checks, and permission hints
 */

import { execa, ExecaError, type Options } from 'execa';
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
  ToolProgress,
  ToolInterruptBehavior,
} from '../types.js';
import { SandboxManager, getActiveProvider, executeIsolated, wrapCommand } from '../../sandbox/index.js';
import { resolveShellProvider, type ShellProviderKind } from '../../utils/shell/providers.js';
import { getBashOutputDir } from '../../utils/duyaRoot.js';
import { killProcessTree } from '../../utils/processTreeKill.js';
import {
  analyzeShellFailure,
  normalizeShellCommandForExecution,
  resolveShellExecutionPlan,
} from '../../utils/shell/intelligence.js';
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_SOFT_YIELD_MS,
} from './constants.js';
import { buildGitReminder } from './git-reminder.js';
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
 * a file under ~/.duya/bash-outputs (durable across reboots, unlike
 * os.tmpdir), and tell the model where it is so it can read more on demand.
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
    fullOutputPath = join(getBashOutputDir(), `duya-bash-full-${crypto.randomUUID()}.log`);
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

/**
 * Build the env block for a foreground bash subprocess. Strips any var whose
 * name matches a sensitive-token regex (TOKEN/KEY/SECRET/PASSWORD/PASSPHRASE/
 * PRIVATE/CREDENTIAL), then layers in the Windows UTF-8 fixups on top.
 * Exported for unit-test coverage of the sanitisation policy.
 */
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
    'For long-running commands, set run_in_background=true and you will be notified on completion; use get_task_output with the returned task ID for a status/output snapshot (never to block), and kill_task to terminate a background task if needed.',
  providerKind: 'bash',
  commandLabel: 'bash command',
  securityCheck: analyzeCommandSafety,
  readOnlyCheck: isReadOnlyCommand,
  normalizeCommandForExecution: (command) => normalizeShellCommandForExecution('bash', command),
};

/**
 * Whether the input asks for explicit background execution. Used by
 * validateBashInput to pick the right `timeout` ceiling before the rest of
 * the input has been normalised.
 */
function isExplicitBackground(obj: Record<string, unknown>): boolean {
  return obj.run_in_background === true || obj.background === true;
}

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
    // Foreground and background have different ceilings — foreground is capped
    // tighter (5 min) to force long commands to opt into run_in_background.
    // Background keeps the historical 10-min ceiling so existing long-running
    // background flows are not broken by this change.
    const maxAllowed = isExplicitBackground(obj)
      ? BASH_MAX_TIMEOUT_MS
      : BASH_MAX_FOREGROUND_TIMEOUT_MS;
    if (obj.timeout > maxAllowed) {
      return {
        valid: false,
        error: isExplicitBackground(obj)
          ? `timeout cannot exceed ${BASH_MAX_TIMEOUT_MS}ms (${BASH_MAX_TIMEOUT_MS / 60000} minutes) for background commands`
          : `timeout cannot exceed ${BASH_MAX_FOREGROUND_TIMEOUT_MS}ms (${BASH_MAX_FOREGROUND_TIMEOUT_MS / 60000} minutes) for foreground commands; use run_in_background=true for longer commands`,
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
          description:
            `Timeout in milliseconds. Foreground: default ${BASH_DEFAULT_TIMEOUT_MS}, ` +
            `max ${BASH_MAX_FOREGROUND_TIMEOUT_MS}. ` +
            `Background: up to ${BASH_MAX_TIMEOUT_MS}. ` +
            `Foreground commands that do not finish within ${BASH_SOFT_YIELD_MS}ms ` +
            `are auto-promoted to a managed background task and the tool call ` +
            `returns a task id without restarting the process.`,
        },
        description: {
          type: 'string',
          description: 'Optional description for the command',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Start in the background and return a task id immediately. ' +
            `Foreground commands may also return a task id after ${BASH_SOFT_YIELD_MS}ms ` +
            'without restarting the process.',
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

  /**
   * Plan 550 step 3a — bash can read/write arbitrary filesystem paths
   * depending on the command, so we cannot resolve a precise path set.
   * The orchestrator treats the unknown sentinel as "any other tool
   * that touches any path must serialise against this one", which is
   * the safe default. Tools that override `extractWritePaths` /
   * `extractReadPaths` (none yet) opt into precise serialisation.
   */
  readonly dependencies: ToolDependencyDeclaration = Object.freeze({
    readPaths: [...UNKNOWN_PATHS],
    writePaths: [...UNKNOWN_PATHS],
    requires: [],
    produces: [],
    consumes: [],
  });

  /**
   * Spawn a foreground bash command with stdio redirected to an output file.
   * Returns the live subprocess plus a promise that resolves with the captured
   * output once the process exits. The caller is responsible for either
   * awaiting the promise (normal foreground completion) or detaching the
   * subprocess via `proc.unref()` and registering it for background tracking
   * (soft-yield promotion).
   *
   * Using a file instead of execa's in-memory capture is what makes the
   * soft-yield race safe: when the timer wins we abandon the foreground
   * promise but the output is still preserved on disk for the background
   * task to read back later.
   */
  private async spawnForegroundProcess(params: {
    finalCommand: string;
    shellInfo: import('../../utils/shellDetector.js').ShellInfo;
    shellArgs: string[];
    cwd: string;
    timeoutMs: number;
    abortSignal: AbortSignal | undefined;
    taskIdHint: string;
  }): Promise<{
    proc: ChildProcess;
    outputFile: string;
    exitPromise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; output: string }>;
  }> {
    const outputFile = join(getBashOutputDir(), `duya-bash-fg-${params.taskIdHint}.log`);
    const fd = await open(outputFile, 'w', 0o644);
    const env = buildSanitizedBashEnv();

    const proc = spawn(params.shellInfo.path, params.shellArgs, {
      cwd: params.cwd,
      env,
      stdio: ['ignore', fd.fd, fd.fd],
      windowsHide: true,
    });

    // Abort before soft-yield: kill the process tree so the foreground tool
    // call truly ends. After the soft-yield race resolves (either side) this
    // listener is removed and the foreground path's own close handlers take
    // over — see register for a soft-yield for the background side.
    let treeKillOnAbort: (() => void) | undefined;
    if (params.abortSignal) {
      treeKillOnAbort = () => {
        const pid = proc.pid;
        if (pid) {
          void killProcessTree(pid);
        }
      };
      params.abortSignal.addEventListener('abort', treeKillOnAbort, { once: true });
    }

    const exitPromise = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolve) => {
      proc.on('close', async (exitCode, signal) => {
        if (treeKillOnAbort && params.abortSignal) {
          params.abortSignal.removeEventListener('abort', treeKillOnAbort);
        }
        try { await fd.close(); } catch { /* already closed */ }
        let output = '';
        try {
          output = await readFile(outputFile, 'utf-8');
        } catch {
          output = '';
        }
        resolve({ exitCode, signal, output });
      });
      proc.on('error', async (err) => {
        if (treeKillOnAbort && params.abortSignal) {
          params.abortSignal.removeEventListener('abort', treeKillOnAbort);
        }
        try { await fd.close(); } catch { /* already closed */ }
        resolve({ exitCode: -1, signal: null, output: err.message });
      });
    });

    // Honour the user's overall timeout as a hard kill. If soft-yield fires
    // first we let the process keep running (it becomes a background task).
    const hardKillTimer = setTimeout(() => {
      const pid = proc.pid;
      if (pid) void killProcessTree(pid);
    }, params.timeoutMs);

    proc.once('close', () => clearTimeout(hardKillTimer));
    proc.once('error', () => clearTimeout(hardKillTimer));

    return { proc, outputFile, exitPromise };
  }

  /**
   * Promote a foreground subprocess that has outlived the soft-yield window
   * to a managed background task. The subprocess stays running, the registry
   * is updated, and a completion notification is queued via the mailbox so
   * the LLM can resume the conversation once the process actually exits.
   */
  private promoteForegroundToBackground(params: {
    proc: ChildProcess;
    outputFile: string;
    taskId: string;
    sessionId: string | undefined;
    originalCommand: string;
    softYieldMs: number;
    startTime: number;
    securityWarnings: SecurityWarning[];
    executionPlanReason?: string;
  }): ToolResult {
    const { proc, outputFile, taskId, sessionId, originalCommand, startTime } = params;
    const registry = getBashTaskRegistry();
    const pid = proc.pid ?? -1;

    registry.register({
      id: taskId,
      pid,
      outputFile,
      command: originalCommand.slice(0, 200),
      status: 'running',
      startTime,
    });

    // Once we hand off to the background registry, the foreground tool call's
    // abort signal no longer kills the process. The user can still stop the
    // task via kill_task / the TaskDrawer UI, which goes through registry.stopTask.
    proc.unref();

    proc.on('close', (exitCode) => {
      registry.markCompleted(taskId, exitCode ?? -1);
      if (!sessionId) return;
      const completedTask = registry.getTask(taskId);
      const status = exitCode === 0 ? 'completed' : 'failed';
      const finalMessage = `Background command (auto-promoted after ${params.softYieldMs}ms) completed with exit code ${exitCode ?? -1}.`;
      const xml = buildTaskNotificationXml({
        taskId,
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
      void sendBackgroundNotification({ sessionId, xml, taskId });
    });

    proc.on('error', (err) => {
      registry.markCompleted(taskId, -1, err.message);
    });

    const lines: string[] = [
      `[Background] Foreground command did not complete within ${params.softYieldMs}ms and was auto-promoted to a managed background task (no process restart).`,
      `[Background] Task ID: ${taskId}`,
      `[Background] PID: ${pid}`,
      `[Background] Output file: ${outputFile}`,
      `You will be notified automatically when it completes. Do not wait or poll for it.`,
      `Use ${GET_TASK_OUTPUT_TOOL_NAME} only for a quick status/output snapshot; it never blocks.`,
      `Use kill_task to terminate the task if needed.`,
    ];
    if (params.executionPlanReason) lines.unshift(`[Shell] ${params.executionPlanReason}`);
    const nonCritical = params.securityWarnings.filter(w => w.severity !== 'critical' && w.severity !== 'high');
    if (nonCritical.length > 0) {
      lines.unshift(`[Warning] ${nonCritical.map(w => w.message).join('; ')}`);
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: lines.join('\n'),
      metadata: {
        autoPromoted: true,
        pid,
        outputFile,
        taskId,
        softYieldMs: params.softYieldMs,
      },
    };
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
          const gitReminder = buildGitReminder(command);
          if (gitReminder) {
            resultOutput = `${resultOutput}\n\n${gitReminder}`;
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

      // Non-Docker path: wrap command (bubblewrap or none) then spawn with
      // stdio redirected to a file so we can detach on the soft-yield race.
      const finalCommand = await wrapCommand(normalizedCommand, cwd);

      const nonCriticalWarnings = securityResult.warnings.filter(
        w => w.severity !== 'critical' && w.severity !== 'high'
      );

      const taskIdHint = context?.toolUseId ?? crypto.randomUUID();
      const startTime = Date.now();
      const spawned = await this.spawnForegroundProcess({
        finalCommand,
        shellInfo,
        shellArgs: shellProvider.buildArgs(finalCommand),
        cwd,
        timeoutMs: resolvedTimeout,
        abortSignal: context?.abortController?.signal,
        taskIdHint,
      });

      // Soft-yield race: wait up to BASH_SOFT_YIELD_MS for the command to
      // finish naturally. If it does not, promote it to a managed background
      // task — the process keeps running, the foreground tool call returns
      // a task id, and the LLM is notified on completion via the mailbox.
      let softYieldTimer: NodeJS.Timeout | undefined;
      const softYieldWin = new Promise<{ kind: 'soft_yield' }>((resolve) => {
        softYieldTimer = setTimeout(() => resolve({ kind: 'soft_yield' }), BASH_SOFT_YIELD_MS);
        softYieldTimer.unref?.();
      });

      const completed = await Promise.race<{
        kind: 'completed';
        value: Awaited<typeof spawned.exitPromise>;
      } | { kind: 'soft_yield' }>([
        spawned.exitPromise.then((value) => ({ kind: 'completed' as const, value })),
        softYieldWin,
      ]);

      if (completed.kind === 'soft_yield') {
        // Promote without restarting: proc keeps running, registry tracks it.
        return this.promoteForegroundToBackground({
          proc: spawned.proc,
          outputFile: spawned.outputFile,
          taskId: taskIdHint,
          sessionId: context?.options.sessionId,
          originalCommand: command,
          softYieldMs: BASH_SOFT_YIELD_MS,
          startTime,
          securityWarnings: securityResult.warnings,
          executionPlanReason: executionPlan.reason,
        });
      }

      // Process finished inside the soft-yield window — clear the timer and
      // return the captured output the same way the old execa path did.
      if (softYieldTimer) clearTimeout(softYieldTimer);

      const { exitCode, output: rawOutput } = completed.value;
      const durationMs = Date.now() - startTime;

      let output = rawOutput.trim();

      if (nonCriticalWarnings.length > 0) {
        const warningMsg = `[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`;
        output = `${warningMsg}\n\n${output}`;
      }

      if (executionPlan.reason) {
        output = `[Shell] ${executionPlan.reason}\n\n${output}`;
      }
      const gitReminder = buildGitReminder(command);
      if (gitReminder) {
        output = `${output}\n\n${gitReminder}`;
      }

      const { output: boundedOutput, fullOutputPath } = truncateShellOutput(output);
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: boundedOutput || '(no output)',
        error: exitCode !== 0 && exitCode !== null,
        metadata: {
          exitCode: exitCode ?? undefined,
          durationMs,
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
        const gitReminder = buildGitReminder(command);
        if (gitReminder) {
          finalOutput = `${finalOutput}\n\n${gitReminder}`;
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
   * log file under ~/.duya/bash-outputs, registers it in BashTaskRegistry so
   * the UI can list/inspect it, and returns immediately. When the process exits, the close handler
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

    const outputFile = join(getBashOutputDir(), `duya-bash-${toolUseId}.log`);

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
      lines.push(`Use ${GET_TASK_OUTPUT_TOOL_NAME} only for a quick status/output snapshot; it never blocks.`);

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

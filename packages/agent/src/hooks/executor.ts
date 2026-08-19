/**
 * Hook executors (plan 426 Phase 4 / plan 87 vocabulary).
 *
 * Executes a configured hook (command / http; prompt & agent are stubbed)
 * against a {@link BaseHookInput} and returns an additionalContext string on
 * success. Fail-open contract: every failure mode returns
 * `{ ok: false, error }` — the caller logs WARN and continues; a broken hook
 * must never break the agent loop.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, basename as pathBasename } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  BaseHookInput,
  BashCommandHook,
  HookCommand,
  HttpHook,
  ProcessCommandHook,
} from './types.js';
import { expandHookTemplate } from './types.js';
import { hookTaskRegistry, type HookBackgroundTask } from './task-registry.js';
import { notifyHookTaskSettled } from './notify.js';
import { logger } from '../utils/logger.js';

export interface HookExecutionResult {
  ok: boolean;
  additionalContext?: string;
  error?: string;
  /**
   * Set only when a `command` hook exits non-zero (verifier semantics — the
   * process ran but reported problems). Absent for infra failures such as
   * spawn failure or timeout. Lets callers feed verifier diagnostics back to
   * the model while keeping true failures silent (fail-open).
   */
  exitCode?: number;
  /**
   * Present when the hook was launched in the background (async: true) —
   * the registered HookTaskRegistry id. No context is returned now; the
   * result arrives later via a mailbox notification.
   */
  backgroundTaskId?: string;
}

/** Cap for collected stdout / stderr streams (64 KB each). */
const MAX_STREAM_BYTES = 64 * 1024;
/** Cap for plain-text stdout promoted to additionalContext verbatim. */
const MAX_PLAIN_CONTEXT_BYTES = 16 * 1024;
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const COMMAND_TIMEOUT_RANGE: readonly [number, number] = [1, 300];
const DEFAULT_HTTP_TIMEOUT_SEC = 30;
const HTTP_TIMEOUT_RANGE: readonly [number, number] = [1, 120];

const NOT_IMPLEMENTED_ERROR =
  'prompt/agent hook executors are not implemented yet (plan 87)';

/** Execution options shared by every executor. */
export interface HookExecutionOptions {
  /** Working directory for spawned processes. */
  cwd: string;
  /** `${KEY}` expansion values for `process` hooks (command + args). */
  vars?: Record<string, string>;
}

const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
const PROCESS_TIMEOUT_RANGE: readonly [number, number] = [1_000, 300_000];

// ============================================================================
// command executor
// ============================================================================

/**
 * Execute a `type: "command"` hook: spawn via the platform shell, pipe the
 * hook input as JSON on stdin, collect stdout/stderr (64 KB cap each), kill
 * after the timeout (default 60s, clamped 1–300s).
 *
 * Exit 0: stdout that parses as JSON with a string `additionalContext` field
 * uses it verbatim; otherwise non-empty stdout becomes additionalContext
 * verbatim (first 16 KB). Anything else → `{ ok: false, error }`.
 */
export function executeHookCommand(
  hook: BashCommandHook,
  input: BaseHookInput,
  opts: HookExecutionOptions,
): Promise<HookExecutionResult> {
  const timeoutSec = clampTimeout(hook.timeout, DEFAULT_COMMAND_TIMEOUT_SEC, COMMAND_TIMEOUT_RANGE);
  return runCollectedProcess(
    { command: hook.command, shell: true },
    input,
    opts,
    timeoutSec * 1000,
  );
}

/**
 * Execute a `type: "process"` hook (ZCode hooks.json alignment): spawn
 * `command` directly with an explicit `args` array — NO shell — after
 * expanding `${KEY}` placeholders in both via {@link expandHookTemplate}.
 * Same stdin-JSON input, 64 KB stream caps, and exit-0 → additionalContext
 * contract as the `command` executor; `timeoutMs` defaults to 60s (clamped
 * 1–300s).
 */
export function executeProcessHook(
  hook: ProcessCommandHook,
  input: BaseHookInput,
  opts: HookExecutionOptions,
): Promise<HookExecutionResult> {
  const timeoutMs = clampTimeout(
    hook.timeoutMs,
    DEFAULT_PROCESS_TIMEOUT_MS,
    PROCESS_TIMEOUT_RANGE,
  );
  const vars = opts.vars ?? {};
  return runCollectedProcess(
    {
      command: expandHookTemplate(hook.command, vars),
      args: (hook.args ?? []).map((a) => expandHookTemplate(a, vars)),
      shell: false,
    },
    input,
    opts,
    timeoutMs,
  );
}

interface SpawnSpec {
  command: string;
  args?: string[];
  shell?: boolean;
}

/**
 * Resolve the executable for a `process` hook spawn.
 *
 * A hook configured with `command: "node"` must run on the SAME Node
 * runtime the app was built for: better-sqlite3 is compiled for the
 * Electron ABI, while a PATH-resolved system `node` ships a different ABI
 * and fails to load it (ERR_DLOPEN_FAILED) — the hook then fails open and
 * silently injects nothing. Re-exec via the app's own binary with
 * `ELECTRON_RUN_AS_NODE=1` (the same pattern agent-server-lifecycle uses to
 * spawn the agent process), so node hooks work in dev and in the packaged
 * app, which may not ship a system `node` at all. Under a plain-node host
 * (CLI/CI) the translation is a no-op: `process.execPath` IS node.
 *
 * Exported for tests.
 */
export function resolveProcessSpawn(
  spec: SpawnSpec,
): { command: string; env?: NodeJS.ProcessEnv } {
  if (spec.shell) return { command: spec.command };
  const base = pathBasename(spec.command).toLowerCase();
  if (base !== 'node' && base !== 'node.exe') return { command: spec.command };
  return {
    command: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Shared spawn + collect + timeout runner for the `command` and `process`
 * executors. Pipes the hook input as JSON on stdin (swallowing EPIPE for
 * hooks that never read it), collects stdout/stderr with byte caps, and
 * kills the child (plus its pipe ends) on timeout.
 */
function runCollectedProcess(
  spec: SpawnSpec,
  input: BaseHookInput,
  opts: HookExecutionOptions,
  timeoutMs: number,
): Promise<HookExecutionResult> {
  return new Promise<HookExecutionResult>((resolve) => {
    let child;
    const resolved = resolveProcessSpawn(spec);
    try {
      child = spawn(resolved.command, spec.args ?? [], {
        shell: spec.shell ?? false,
        cwd: opts.cwd,
        ...(resolved.env ? { env: resolved.env } : {}),
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let settled = false;
    const stdout = makeCollector(MAX_STREAM_BYTES);
    const stderr = makeCollector(MAX_STREAM_BYTES);

    const finish = (result: HookExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Process may have exited between timeout fire and kill.
      }
      // Drop our ends of the pipes so a lingering grandchild (spawned via the
      // shell) cannot keep this process's event loop alive after the kill.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
      finish({ ok: false, error: `hook process timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.on('error', (err) => finish({ ok: false, error: `spawn failed: ${err.message}` }));
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (code) => {
      if (code === 0) {
        finish(parseCommandOutput(stdout.text()));
        return;
      }
      const errText = stderr.text().trim();
      finish({
        ok: false,
        exitCode: code ?? undefined,
        error: `hook process exited with code ${code}${errText ? `: ${errText.slice(0, 512)}` : ''}`,
      });
    });

    // Pipe the hook input; swallow EPIPE for hooks that never read stdin.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input), 'utf-8');
  });
}

/** Interpret successful command stdout: JSON `additionalContext` if present, else plain text. */
function parseCommandOutput(stdout: string): HookExecutionResult {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const ctx = (parsed as { additionalContext?: unknown })?.additionalContext;
      if (parsed && typeof parsed === 'object' && typeof ctx === 'string') {
        return { ok: true, additionalContext: ctx };
      }
    } catch {
      // Not JSON — fall through to plain-text handling.
    }
    return { ok: true, additionalContext: stdout.slice(0, MAX_PLAIN_CONTEXT_BYTES) };
  }
  return { ok: true };
}

// ============================================================================
// http executor
// ============================================================================

/**
 * Execute a `type: "http"` hook: POST the hook input as JSON to `hook.url`
 * (custom headers merged over a default `Content-Type: application/json`),
 * AbortController-bounded by `hook.timeout` seconds (default 30, clamped
 * 1–120). Any 2xx whose body parses as JSON with a string `additionalContext`
 * field yields that context; everything else fails open.
 */
export async function executeHttpHook(
  hook: HttpHook,
  input: BaseHookInput,
): Promise<HookExecutionResult> {
  const timeoutSec = clampTimeout(hook.timeout, DEFAULT_HTTP_TIMEOUT_SEC, HTTP_TIMEOUT_RANGE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(hook.headers ?? {}) },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http hook returned status ${res.status}` };
    }
    const body = await res.text();
    try {
      const parsed: unknown = JSON.parse(body);
      const ctx = (parsed as { additionalContext?: unknown })?.additionalContext;
      if (parsed && typeof parsed === 'object' && typeof ctx === 'string') {
        return { ok: true, additionalContext: ctx };
      }
    } catch {
      // Non-JSON 2xx body — success without context.
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `http hook timed out after ${timeoutSec}s` : message };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// background executor (async: true)
// ============================================================================

/**
 * Result of launching a background hook: the task is registered and the
 * caller must NOT await its completion — the event chain continues.
 */
export type BackgroundHookLaunch =
  | { ok: true; background: true; taskId: string }
  | { ok: false; error: string };

/**
 * Launch an `async: true` command/process hook in the background.
 *
 * The child is spawned and left to run; stdout+stderr stream into an on-disk
 * output file (tmpdir/duya-hook-<uuid>.log) while a 64 KB ring buffer keeps
 * the tail for additionalContext parsing. On settle the task is marked
 * completed/error and — when `asyncRewake` is set — its result is delivered
 * via a mailbox background_notification (./notify.ts), so the hook output
 * lands in the session message stream like any background bash task.
 *
 * Background tasks are NOT bounded by the sync timeout: they run until the
 * process exits or the session tears down (registry.finalizeAll). Fail-open:
 * spawn failure registers a killed task and returns ok:false.
 */
export function executeHookBackground(
  hook: BashCommandHook | ProcessCommandHook,
  input: BaseHookInput & { hook_event_name: string },
  opts: HookExecutionOptions,
): BackgroundHookLaunch {
  const spec: SpawnSpec =
    hook.type === 'process'
      ? {
          command: expandHookTemplate(hook.command, opts.vars ?? {}),
          args: (hook.args ?? []).map((a) => expandHookTemplate(a, opts.vars ?? {})),
          shell: false,
        }
      : { command: hook.command, shell: true };

  const taskId = `hook-${randomUUID()}`;
  const outputFile = join(tmpdir(), `duya-hook-${randomUUID()}.log`);
  const task: HookBackgroundTask = {
    id: taskId,
    event: input.hook_event_name,
    hookType: hook.type,
    command: spec.args?.length ? `${spec.command} ${spec.args.join(' ')}` : spec.command,
    sessionId: input.session_id,
    rewake: hook.asyncRewake === true,
    pid: null,
    outputFile,
    status: 'running',
    startTime: Date.now(),
  };
  hookTaskRegistry.register(task);

  let child;
  const resolved = resolveProcessSpawn(spec);
  try {
    child = spawn(resolved.command, spec.args ?? [], {
      shell: spec.shell ?? false,
      cwd: opts.cwd,
      detached: false,
      ...(resolved.env ? { env: resolved.env } : {}),
    });
  } catch (err) {
    const message = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    hookTaskRegistry.markKilled(taskId, message);
    return { ok: false, error: message };
  }

  task.pid = child.pid ?? null;
  hookTaskRegistry.update(taskId, { pid: task.pid });

  // Ring-buffer the tail for additionalContext parsing; tee everything to
  // the output file for later reads.
  let tail = '';
  const appendChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    tail = (tail + text).slice(-MAX_BACKGROUND_TAIL_BYTES);
    try {
      appendFileSync(outputFile, text, 'utf-8');
    } catch (err) {
      logger.warn(
        `[Hooks] background output write failed (${outputFile}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  child.stdout?.on('data', appendChunk);
  child.stderr?.on('data', appendChunk);
  child.on('error', (err) => {
    hookTaskRegistry.markKilled(taskId, `spawn failed: ${err.message}`);
    void notifyHookTaskSettled(hookTaskRegistry.getTask(taskId)!);
  });
  child.on('close', (code) => {
    const exitCode = code ?? 1;
    const error =
      exitCode === 0 ? undefined : `hook process exited with code ${exitCode}`;
    hookTaskRegistry.markCompleted(taskId, exitCode, error);
    const settled = hookTaskRegistry.getTask(taskId);
    if (!settled) return;
    logger.info(
      `[Hooks] background ${hook.type} hook settled (${taskId}) ` +
        `event=${input.hook_event_name} status=${settled.status} exit=${exitCode} ` +
        `rewake=${String(settled.rewake)} output=${outputFile}`,
    );
    void notifyHookTaskSettled(settled, parseBackgroundContext(tail));
  });

  // Pipe the hook input; swallow EPIPE for hooks that never read stdin.
  child.stdin?.on('error', () => {});
  child.stdin?.end(JSON.stringify(input), 'utf-8');

  logger.info(`[Hooks] background ${hook.type} hook started (${taskId}): ${spec.command}`);
  return { ok: true, background: true, taskId };
}

/** Ring buffer cap for the background stdout tail used for context parsing. */
const MAX_BACKGROUND_TAIL_BYTES = 64 * 1024;

/** Interpret background stdout: JSON `additionalContext` if present, else plain text. */
function parseBackgroundContext(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const ctx = (parsed as { additionalContext?: unknown })?.additionalContext;
    if (parsed && typeof parsed === 'object' && typeof ctx === 'string') return ctx;
  } catch {
    // Not JSON — fall through to plain-text handling.
  }
  return trimmed.slice(0, MAX_PLAIN_CONTEXT_BYTES);
}

// ============================================================================
// dispatcher
// ============================================================================

/**
 * Dispatch by hook type. `async: true` command/process hooks launch in the
 * background (see executeHookBackground) and resolve immediately as
 * `{ ok: true, backgroundTaskId }`; everything else runs synchronously and
 * awaits completion. prompt/agent are plan-87 follow-ups (fail open).
 */
export async function executeHook(
  hook: HookCommand,
  input: BaseHookInput & { hook_event_name: string },
  opts: HookExecutionOptions,
): Promise<HookExecutionResult> {
  if (hook.type === 'command' || hook.type === 'process') {
    if (hook.async === true) {
      const launched = executeHookBackground(hook, input, opts);
      if (launched.ok) return { ok: true, backgroundTaskId: launched.taskId };
      return { ok: false, error: launched.error };
    }
  }
  const started = Date.now();
  const result = await (async () => {
    switch (hook.type) {
      case 'command':
        return executeHookCommand(hook, input, opts);
      case 'process':
        return executeProcessHook(hook, input, opts);
      case 'http':
        return executeHttpHook(hook, input);
      case 'prompt':
      case 'agent':
        logger.warn(`[HookExecutor] ${NOT_IMPLEMENTED_ERROR}`);
        return { ok: false, error: NOT_IMPLEMENTED_ERROR };
    }
  })();
  logger.debug(
    `[Hooks] ${input.hook_event_name} ${hook.type} hook completed in ${Date.now() - started}ms ` +
      `ok=${String(result.ok)}${result.exitCode !== undefined ? ` exit=${result.exitCode}` : ''}`,
  );
  return result;
}

// ============================================================================
// helpers
// ============================================================================

/** Byte-capped text collector for a child stream. */
interface StreamCollector {
  push(chunk: Buffer): void;
  text(): string;
}
function makeCollector(capBytes: number): StreamCollector {
  let text = '';
  let bytes = 0;
  return {
    push(chunk: Buffer): void {
      if (bytes >= capBytes) return;
      const slice = chunk.subarray(0, capBytes - bytes);
      text += slice.toString('utf-8');
      bytes += slice.length;
    },
    text(): string {
      return text;
    },
  };
}

function clampTimeout(v: number | undefined, fallback: number, [min, max]: readonly [number, number]): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return clamp(Math.floor(n), min, max);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

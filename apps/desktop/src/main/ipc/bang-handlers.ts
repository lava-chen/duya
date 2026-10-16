/**
 * apps/desktop/src/main/ipc/bang-handlers.ts
 *
 * IPC surface for the composer's `!cmd` bash-prefix mode (minimax / codex
 * parity): the renderer sends the raw command line typed after `!`, the main
 * process runs it through a shell with a bounded timeout and returns the
 * captured output. The renderer is trusted here — the same model as the
 * agent's BashTool — because `!` mode is explicit user intent, so there is no
 * confirmation dialog.
 *
 * Channels (renderer -> main, invoke):
 *   - bang:run ({ command, cwd?, timeoutMs? })
 *       -> { ok: true, output, durationMs, exitCode }
 *        | { ok: false, error, output?, durationMs }
 *
 * Payload validation mirrors `bash-task-handlers.ts` (typeof checks, trimmed
 * non-empty command). Execution uses `node:child_process.spawn` with
 * `shell: true` (cmd.exe on Windows, /bin/sh elsewhere); stdout and stderr are
 * both captured and merged, capped at 256 KB with a `… [truncated]` marker.
 * On timeout the child tree is killed (taskkill /T /F on Windows, the POSIX
 * process group) and the result resolves immediately — waiting for `close`
 * would stall on any grandchild that survives the shell kill and keeps the
 * stdio pipes open.
 */

import { ipcMain } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/** Default / bounds for the per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/** Combined stdout+stderr cap (256 KB) plus the marker appended on overflow. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const TRUNCATION_MARKER = '\n… [truncated]';

/** Grace period between SIGTERM and SIGKILL on POSIX. */
const FORCE_KILL_DELAY_MS = 2_000;

/** How much of the command line we echo into logs (keep them readable). */
const COMMAND_PREVIEW_LIMIT = 200;

interface BangRunPayload {
  command?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
}

export type BangRunResultPayload =
  | { ok: true; output: string; durationMs: number; exitCode: number }
  | { ok: false; error: string; output?: string; durationMs: number };

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function commandPreview(command: string): string {
  return command.length > COMMAND_PREVIEW_LIMIT
    ? `${command.slice(0, COMMAND_PREVIEW_LIMIT)}…`
    : command;
}

/**
 * Kill the child and everything it spawned.
 *
 * Windows: `taskkill /T /F` takes the shell AND the command it launched. It
 * must run before `child.kill()` — once the shell is gone its pid is gone and
 * taskkill reports "process not found" (verified on Windows: taskkill alone
 * reaps the whole tree; `child.kill()` alone leaves an orphaned grandchild
 * holding the stdio pipes open, which delays `close` by the command's full
 * remaining runtime).
 *
 * POSIX: spawn is `detached`, so the child leads its own process group and
 * `process.kill(-pid)` signals the whole tree at once.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
          /* best effort: taskkill exits non-zero once the tree is gone */
        });
      } catch {
        /* taskkill unavailable — fall through to child.kill() */
      }
    }
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    return;
  }
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
      return;
    }
  } catch {
    /* group already gone — fall back to the child itself */
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
}

/** POSIX-only: escalate to SIGKILL when the tree ignores SIGTERM. */
function forceKillTree(child: ChildProcess): void {
  if (process.platform === 'win32') return;
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
}

export function registerBangHandlers(): void {
  ipcMain.handle(
    'bang:run',
    async (
      _event,
      payload: BangRunPayload | undefined,
    ): Promise<BangRunResultPayload> => {
      const startedAt = Date.now();

      const command =
        typeof payload?.command === 'string' ? payload.command.trim() : '';
      if (!command) {
        return { ok: false, error: 'missing command', durationMs: 0 };
      }

      const requestedCwd =
        typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
      // Empty / missing cwd falls back to the main process cwd; a cwd that
      // does not exist is rejected before spawning anything.
      let cwd = process.cwd();
      if (requestedCwd) {
        try {
          if (!existsSync(requestedCwd) || !statSync(requestedCwd).isDirectory()) {
            return {
              ok: false,
              error: `cwd not found: ${requestedCwd}`,
              durationMs: Date.now() - startedAt,
            };
          }
        } catch (err) {
          logger.warn(
            'bang:run cwd check failed',
            { command: commandPreview(command), cwd: requestedCwd, error: String(err) },
            LogComponent.Main,
          );
          return {
            ok: false,
            error: `cwd not found: ${requestedCwd}`,
            durationMs: Date.now() - startedAt,
          };
        }
        cwd = requestedCwd;
      }

      const timeoutMs = clampTimeout(payload?.timeoutMs);

      return new Promise<BangRunResultPayload>((resolve) => {
        const chunks: string[] = [];
        let capturedBytes = 0;
        let truncated = false;
        let settled = false;
        let timeoutTimer: NodeJS.Timeout | null = null;
        let forceKillTimer: NodeJS.Timeout | null = null;

        const appendChunk = (chunk: Buffer): void => {
          if (truncated) return;
          const remaining = MAX_OUTPUT_BYTES - capturedBytes;
          if (chunk.length <= remaining) {
            capturedBytes += chunk.length;
            chunks.push(chunk.toString('utf8'));
            return;
          }
          // Keep the head up to the cap and stop appending entirely.
          capturedBytes = MAX_OUTPUT_BYTES;
          truncated = true;
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining).toString('utf8'));
          chunks.push(TRUNCATION_MARKER);
        };

        const output = (): string => chunks.join('');

        const settle = (result: BangRunResultPayload): void => {
          if (settled) return;
          settled = true;
          if (timeoutTimer !== null) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (forceKillTimer !== null) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
          resolve(result);
        };

        let child: ChildProcess;
        try {
          child = spawn(command, {
            shell: true,
            cwd,
            windowsHide: true,
            // POSIX: own process group so killTree can signal the whole tree.
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          logger.warn(
            'bang:run spawn failed',
            { command: commandPreview(command), cwd, error: String(err) },
            LogComponent.Main,
          );
          resolve({
            ok: false,
            error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            output: '',
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        timeoutTimer = setTimeout(() => {
          if (settled) return;
          const durationMs = Date.now() - startedAt;
          const captured = output();
          killTree(child);
          logger.warn(
            'bang:run timed out',
            { command: commandPreview(command), cwd, timeoutMs },
            LogComponent.Main,
          );
          // Resolve right away instead of waiting for `close`: the run is over
          // from the user's point of view, and `close` can lag by the command's
          // full remaining runtime when a grandchild survives the shell kill.
          settle({ ok: false, error: `timeout after ${timeoutMs}ms`, output: captured, durationMs });
          // Release the pipes so nothing keeps the streams (or the child)
          // alive behind the settled promise.
          child.stdout?.destroy();
          child.stderr?.destroy();
          // POSIX escalation if the tree ignores SIGTERM; unref'd so it never
          // holds the event loop open by itself.
          if (process.platform !== 'win32') {
            forceKillTimer = setTimeout(() => forceKillTree(child), FORCE_KILL_DELAY_MS);
            forceKillTimer.unref?.();
          }
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => appendChunk(chunk));
        child.stderr?.on('data', (chunk: Buffer) => appendChunk(chunk));

        child.on('error', (err: Error) => {
          if (settled) return;
          logger.warn(
            'bang:run process error',
            { command: commandPreview(command), cwd, error: err.message },
            LogComponent.Main,
          );
          settle({
            ok: false,
            error: err.message,
            output: output(),
            durationMs: Date.now() - startedAt,
          });
        });

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          const durationMs = Date.now() - startedAt;

          if (signal !== null) {
            logger.warn(
              'bang:run killed by signal',
              { command: commandPreview(command), cwd, signal },
              LogComponent.Main,
            );
            settle({
              ok: false,
              error: `killed by signal ${signal}`,
              output: output(),
              durationMs,
            });
            return;
          }

          const exitCode = code ?? -1;
          if (exitCode !== 0) {
            logger.warn(
              'bang:run exited non-zero',
              { command: commandPreview(command), cwd, exitCode },
              LogComponent.Main,
            );
            settle({ ok: false, error: `exit code ${exitCode}`, output: output(), durationMs });
            return;
          }
          settle({ ok: true, output: output(), durationMs, exitCode });
        });
      });
    },
  );

  logger.info('Bang (`!` bash-prefix) IPC handlers registered', undefined, LogComponent.Main);
}

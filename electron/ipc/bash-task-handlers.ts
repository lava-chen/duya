/**
 * electron/ipc/bash-task-handlers.ts
 *
 * IPC surface for inspecting agent background bash tasks from the renderer.
 *
 * Channels (renderer -> main, invoke):
 *   - bash-task:read-output ({ outputFile, maxBytes? })
 *       -> { ok: true, output, size, truncated } | { ok: false, error }
 *
 * The agent worker registers background tasks and streams snapshots to the
 * renderer via `bash_task:update`; every snapshot carries `outputFile` — the
 * file the detached command's stdout/stderr is redirected to. Reading the
 * tail of that file here (bounded) avoids a renderer->worker round-trip:
 * the worker owns the registry, but the output file itself is plain fs.
 */

import { ipcMain } from 'electron';
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/** Upper bound for a single tail read (256 KB). */
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;

interface ReadOutputPayload {
  outputFile?: unknown;
  maxBytes?: unknown;
}

export type BashTaskReadOutputResult =
  | { ok: true; output: string; size: number; truncated: boolean }
  | { ok: false; error: string };

export function registerBashTaskHandlers(): void {
  ipcMain.handle(
    'bash-task:read-output',
    (_event, payload: ReadOutputPayload | undefined): BashTaskReadOutputResult => {
      const outputFile = typeof payload?.outputFile === 'string' ? payload.outputFile : '';
      if (!outputFile.trim()) {
        return { ok: false, error: 'missing outputFile' };
      }
      let maxBytes = DEFAULT_MAX_BYTES;
      if (typeof payload?.maxBytes === 'number' && Number.isFinite(payload.maxBytes) && payload.maxBytes > 0) {
        maxBytes = Math.min(Math.floor(payload.maxBytes), HARD_MAX_BYTES);
      }

      let fd: number | null = null;
      try {
        const stat = statSync(outputFile);
        // Regular files only: the task output is a plain redirect target, so
        // anything else (device, FIFO, directory) is either a stale or a
        // malformed snapshot path.
        if (!stat.isFile()) {
          return { ok: false, error: 'not a regular file' };
        }
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        if (length === 0) {
          return { ok: true, output: '', size: 0, truncated: false };
        }

        fd = openSync(outputFile, 'r');
        const buf = Buffer.alloc(length);
        const read = readSync(fd, buf, 0, length, start);
        closeSync(fd);
        fd = null;

        // Drop a partial trailing UTF-8 sequence when we cut mid-codepoint.
        let out = buf.subarray(0, read).toString('utf-8');
        if (read < length) out = out; // short read already handled by slice above
        const truncated = start > 0;
        return { ok: true, output: out, size, truncated };
      } catch (err) {
        // Missing file is the common benign case: the registry cleans the
        // entry ~5 min after completion but the output file may already be
        // gone (temp cleanup, workspace removal).
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT') {
          logger.warn('bash-task:read-output failed', undefined, LogComponent.Main);
        }
        return { ok: false, error: code === 'ENOENT' ? 'not found' : 'read failed' };
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
    }
  );

  logger.info('Bash task IPC handlers registered', undefined, LogComponent.Main);
}

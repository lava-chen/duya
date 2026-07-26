/**
 * Memory v2 wakeup IPC handler (Plan 305 Phase B).
 *
 * Renderer-callable IPC channel `memory:wakeup` that triggers an
 * immediate `forceSweep()` on the memory worker. Mirrors the worker
 * event path: agent subprocess → router → forceSweep, but this channel
 * is for renderer-initiated wakeups (e.g. on session restore).
 *
 * Shadow mode: when the worker is not running (DUYA_MEMORY_V2_ENABLED
 * unset), the handler returns `{ accepted: false, reason: 'disabled' }`
 * so the renderer can silently no-op.
 */

import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { getMemoryWorkerHandle } from '../memory/memory-worker';

const logger = getLogger();

export interface MemoryWakeupPayload {
  project_id?: string;
}

export interface MemoryWakeupResponse {
  accepted: boolean;
  reason?: 'disabled' | 'worker-not-started' | 'sweep-in-flight' | 'error';
  error?: string;
}

/**
 * Register the `memory:wakeup` IPC handler. Idempotent — safe to call
 * multiple times (ipcMain.handle throws on duplicate registration, so
 * we guard with `ipcMain.removeHandler` first).
 */
export function registerMemoryWakeupHandlers(): void {
  ipcMain.removeHandler('memory:wakeup');
  ipcMain.handle('memory:wakeup', async (_event, payload: MemoryWakeupPayload): Promise<MemoryWakeupResponse> => {
    const handle = getMemoryWorkerHandle();
    if (!handle) {
      // Worker not started — either DUYA_MEMORY_V2_ENABLED is unset or
      // the worker failed to start. Either way, shadow mode tolerates
      // this as a no-op.
      return { accepted: false, reason: 'disabled' };
    }

    try {
      // fire-and-forget at the IPC boundary; the renderer must not block
      // on extraction. forceSweep runs in the main process.
      void handle.forceSweep();
      return { accepted: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(
        'memory:wakeup IPC handler error',
        { error: errorMessage },
        LogComponent.DB,
      );
      return { accepted: false, reason: 'error', error: errorMessage };
    }
  });
}

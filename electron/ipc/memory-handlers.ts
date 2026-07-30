/**
 * memory-handlers.ts - Renderer-facing IPC for the memory subsystem.
 *
 * Currently read-only: lists durable memory entries from the memory-state DB.
 * Writes are still driven by the memory worker in shadow mode.
 */

import { ipcMain } from 'electron';
import type { MemoryEntry } from '../src/types';
import { getLogger, LogComponent } from '../logging/logger';
import { getDb } from '../memory-state/db';

const logger = getLogger();

export interface MemoryListResponse {
  entries: MemoryEntry[];
  enabled: boolean;
}

/**
 * Register the `memory:list` IPC handler. Idempotent.
 */
export function registerMemoryListHandlers(): void {
  ipcMain.removeHandler('memory:list');
  ipcMain.handle('memory:list', async (): Promise<MemoryListResponse> => {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT memory_id, scope, project_id, kind, canonical_key, content,
                  version, status, created_at, updated_at
           FROM memory_entries
           WHERE status = 'active'
           ORDER BY updated_at DESC`
        )
        .all() as MemoryEntry[];
      return { entries: rows, enabled: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The memory-state DB is only bootstrapped when memory v2 is enabled.
      // Return an empty list instead of throwing so the UI can render a
      // disabled/empty state.
      logger.debug('memory:list returned empty: memory-state DB not available', { error: message }, LogComponent.DB);
      return { entries: [], enabled: false };
    }
  });
}

/**
 * memory-handlers.ts - Renderer-facing IPC for the memory subsystem.
 *
 * Currently read-only: lists durable memory entries from the memory-state DB.
 * Writes are still driven by the memory worker in shadow mode.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import type { MemoryEntry } from '../src/types';
import { getLogger, LogComponent } from '../logging/logger';
import { getDb } from '../memory-state/db';
import { parseCanonicalFile } from '../../packages/agent/src/memory-state/memory_entries_rebuild';

const logger = getLogger();

export interface MemoryListResponse {
  entries: MemoryEntry[];
  enabled: boolean;
}

/**
 * Read active memory entries from live canonical files (Phase D switch).
 *
 * Walks `<memoryRoot>/items/` and `<memoryRoot>/entities/` recursively for
 * `.md` files, parses frontmatter, and returns one `MemoryEntry`-shaped row
 * per active file. Used by the `memory:list` IPC handler when file truth is
 * the source. Returns an empty array on any read error — the UI degrades to
 * an empty list, matching the legacy DB-missing behavior.
 */
export async function listMemoryEntriesFromFiles(memoryRoot: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for (const sub of ['items', 'entities']) {
    const subRoot = path.join(memoryRoot, sub);
    if (!fs.existsSync(subRoot)) continue;
    walkForEntries(subRoot, entries);
  }
  entries.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return entries;
}

function walkForEntries(dir: string, out: MemoryEntry[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkForEntries(full, out);
    } else if (stat.isFile() && entry.endsWith('.md')) {
      const parsed = parseCanonicalFile(full);
      if (!parsed || parsed.status !== 'active') continue;
      out.push({
        memory_id: parsed.memory_id,
        scope: parsed.scope as MemoryEntry['scope'],
        project_id: parsed.project_id,
        kind: parsed.claim_type as MemoryEntry['kind'],
        canonical_key: parsed.canonical_key,
        content: parsed.canonical_key,
        version: 1,
        status: parsed.status as MemoryEntry['status'],
        created_at: Date.parse(parsed.updated_at) || Date.now(),
        updated_at: Date.parse(parsed.updated_at) || Date.now(),
      });
    }
  }
}

function isPhase2Enabled(): boolean {
  const v = process.env.DUYA_MEMORY_PHASE2_ENABLED;
  return v === '1' || v === 'true' || v === undefined; // default on after Phase D
}

/**
 * Register the `memory:list` IPC handler. Idempotent.
 */
export function registerMemoryListHandlers(): void {
  ipcMain.removeHandler('memory:list');
  ipcMain.handle('memory:list', async (): Promise<MemoryListResponse> => {
    try {
      if (isPhase2Enabled()) {
        const memoryRoot = process.env.DUYA_MEMORY_ROOT ?? path.join(os.homedir(), '.duya', 'memory');
        const entries = await listMemoryEntriesFromFiles(memoryRoot);
        return { entries, enabled: true };
      }
      // Legacy DB path (Phase C shadow, only when Phase 2 is explicitly off).
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
      // The memory-state DB is only bootstrapped when memory is enabled.
      // Return an empty list instead of throwing so the UI can render a
      // disabled/empty state.
      logger.debug('memory:list returned empty: memory-state DB not available', { error: message }, LogComponent.DB);
      return { entries: [], enabled: false };
    }
  });
}

/**
 * BashTaskStore — durable, file-backed persistence for BashTaskRegistry.
 *
 * Why a JSON file instead of SQLite? Bash tasks live in the agent
 * subprocess, which has no direct SQLite handle in production — going
 * through the main-process IPC schema would mean modifying
 * `electron/db/schema.ts`, adding a new IPC handler, and shipping the
 * contract change through to the agent. A flat JSON file under
 * `~/.duya/bash-tasks/` keeps the persistence layer self-contained to
 * the agent package and removes the cross-process coupling.
 *
 * Trade-offs vs full SQLite:
 *   - No transactions / atomicity, but every write is a complete
 *     snapshot of all tracked tasks so a torn write only loses a
 *     snapshot, not a partial task.
 *   - No indexed queries; the registry is the hot path. We only
 *     rehydrate from disk on first registry access per process.
 *   - File size grows with task count. We trim completed tasks older
 *     than {@link DEFAULT_TASK_RETENTION_MS} (24h) on every write so
 *     the file stays bounded across long sessions.
 *
 * Mirrors mcode's startup-recovery goal: after an agent restart, the
 * in-memory registry is hydrated from disk and previously-running
 * tasks whose PIDs are no longer alive are marked `lost` instead of
 * silently reappearing as zombie running.
 */

import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getBashOutputDir } from '../utils/duyaRoot.js';
import type { BashBackgroundTask, BashTaskStatus } from './bash-task-registry.js';

const STORE_FILENAME = 'bash-tasks.json';

const DEFAULT_TASK_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

interface PersistedTask {
  id: string;
  pid: number;
  outputFile: string;
  command: string;
  status: BashTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
  lastProgress?: BashBackgroundTask['lastProgress'];
  autoPromoted?: boolean;
  foregroundTimeoutMs?: number;
}

interface PersistedSnapshot {
  version: 1;
  savedAt: number;
  tasks: PersistedTask[];
}

/**
 * Convert an in-memory task into the persisted shape. Strips transient
 * listener metadata so the JSON file only carries state, not behaviour.
 */
function toPersisted(task: BashBackgroundTask): PersistedTask {
  return {
    id: task.id,
    pid: task.pid,
    outputFile: task.outputFile,
    command: task.command,
    status: task.status,
    startTime: task.startTime,
    ...(task.endTime !== undefined ? { endTime: task.endTime } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.lastProgress !== undefined ? { lastProgress: task.lastProgress } : {}),
    ...(task.autoPromoted ? { autoPromoted: true } : {}),
    ...(task.foregroundTimeoutMs !== undefined ? { foregroundTimeoutMs: task.foregroundTimeoutMs } : {}),
  };
}

function fromPersisted(record: PersistedTask): BashBackgroundTask {
  return {
    id: record.id,
    pid: record.pid,
    outputFile: record.outputFile,
    command: record.command,
    status: record.status,
    startTime: record.startTime,
    ...(record.endTime !== undefined ? { endTime: record.endTime } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.lastProgress !== undefined ? { lastProgress: record.lastProgress } : {}),
    ...(record.autoPromoted ? { autoPromoted: true } : {}),
    ...(record.foregroundTimeoutMs !== undefined ? { foregroundTimeoutMs: record.foregroundTimeoutMs } : {}),
  };
}

/**
 * Check if a process is alive. Wrapped so tests can monkey-patch without
 * touching the registry's own implementation.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface BashTaskStoreOptions {
  filePath?: string;
  retentionMs?: number;
  /** Override for tests so we don't have to hit the real filesystem. */
  nowMs?: () => number;
}

/**
 * File-backed write-through store for {@link BashTaskRegistry}. The
 * registry treats this as an optional durability layer: it always calls
 * {@link persist} after a state mutation, but a write failure is logged
 * and swallowed so the in-memory hot path keeps working.
 */
export class BashTaskStore {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly nowMs: () => number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: BashTaskStoreOptions = {}) {
    this.filePath = options.filePath ?? join(getBashOutputDir(), STORE_FILENAME);
    this.retentionMs = options.retentionMs ?? DEFAULT_TASK_RETENTION_MS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Read the persisted snapshot and rehydrate tasks into the registry.
   * Tasks whose status was `running` at last write but whose PID is no
   * longer alive are rewritten as `lost` so the UI doesn't show zombie
   * tasks the user can never inspect.
   *
   * Returns the list of rehydrated tasks (after liveness reconciliation
   * but before any trim). The caller — the registry — decides whether to
   * adopt these as the starting in-memory state.
   */
  async rehydrate(): Promise<BashBackgroundTask[]> {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    let snapshot: PersistedSnapshot;
    try {
      const parsed = JSON.parse(raw) as PersistedSnapshot;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
        return [];
      }
      snapshot = parsed;
    } catch {
      return [];
    }

    const now = this.nowMs();
    const cutoff = now - this.retentionMs;
    const reconciled: BashBackgroundTask[] = [];
    for (const record of snapshot.tasks) {
      // Drop terminal tasks that are older than the retention window — they
      // were useful for the previous session's UI but they should not pile
      // up forever on disk.
      if (record.status !== 'running' && record.endTime !== undefined && record.endTime < cutoff) {
        continue;
      }
      const task = fromPersisted(record);
      if (task.status === 'running' && !isPidAlive(task.pid)) {
        task.status = 'lost';
        task.endTime = now;
        task.error = task.error ?? 'Process exited before agent restart; lost on rehydrate';
      }
      reconciled.push(task);
    }
    return reconciled;
  }

  /**
   * Persist the full task list. Coalesced so concurrent calls share a
   * single write — register/markCompleted/markKilled all fire under load
   * and we don't want to thrash the filesystem.
   */
  persist(tasks: readonly BashBackgroundTask[]): Promise<void> {
    const write = async () => {
      const trimmed = this.trim(tasks);
      const snapshot: PersistedSnapshot = {
        version: 1,
        savedAt: this.nowMs(),
        tasks: trimmed.map(toPersisted),
      };
      try {
        await mkdir(this.directory(), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(snapshot), 'utf-8');
      } catch {
        // Filesystem errors must not break the in-memory registry. The
        // hot path keeps working; the snapshot is best-effort.
      }
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  /**
   * Remove the persisted file. Used by tests and the `clearForTest`
   * reset path.
   */
  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // already gone
    }
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Drop terminal tasks older than `retentionMs`. Running tasks are
   * always kept (until rehydrate decides they are lost on next start).
   */
  private trim(tasks: readonly BashBackgroundTask[]): BashBackgroundTask[] {
    const cutoff = this.nowMs() - this.retentionMs;
    return tasks.filter((t) => {
      if (t.status === 'running') return true;
      if (t.endTime === undefined) return true;
      return t.endTime >= cutoff;
    });
  }

  private directory(): string {
    const idx = this.filePath.lastIndexOf('/');
    const winIdx = this.filePath.lastIndexOf('\\');
    const sep = Math.max(idx, winIdx);
    return sep === -1 ? '.' : this.filePath.slice(0, sep);
  }
}

/**
 * Process-wide singleton so every state mutation lands in the same file.
 * Tests can {@link resetBashTaskStore} between cases to start clean.
 */
let _store: BashTaskStore | null = null;

export function getBashTaskStore(): BashTaskStore {
  if (!_store) {
    _store = new BashTaskStore();
  }
  return _store;
}

export function resetBashTaskStore(): void {
  _store = null;
}
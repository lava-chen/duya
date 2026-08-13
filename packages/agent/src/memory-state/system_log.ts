import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Memory system log (Phase 1 + Phase 2 observability).
 *
 * An append-only JSONL event journal for the memory pipeline so the user
 * can inspect, from the Settings → Memory view, what the system did and
 * when:
 *   - Phase 1: rollout extraction outcomes (started / committed /
 *     no_output / noop / stale / failed), new rollouts materialized by
 *     catalog sync, projection reconciliation, outbox drains.
 *   - Phase 2: curation run lifecycle (started / succeeded / failed /
 *     abandoned), each canonical file changed (append/replace) with the
 *     path + a content snippet, stage1_policy updates, new category
 *     creation, and the curator agent session id for drill-down.
 *
 * Layout follows the Codex-style session tree:
 *   <root>/memory-system-log/YYYY/MM/DD.jsonl
 *   where <root> defaults to ~/.duya (matching rollout/session storage).
 * Each line is one newline-delimited JSON event. Files are append-only and
 * daily-rotated. `listSystemLog` reads them back newest-first.
 *
 * The inner module is framework-agnostic: it only touches the filesystem,
 * so packages/agent can use it without importing the Electron DB singleton.
 */

export type MemoryLogPhase = 'phase1' | 'phase2' | 'system';
export type MemoryLogLevel = 'info' | 'warn' | 'error';

export interface MemoryLogEntry {
  ts: number;
  phase: MemoryLogPhase;
  event_type: string;
  level: MemoryLogLevel;
  message: string;
  detail: Record<string, unknown> | null;
  rollout_id?: string | null;
  run_id?: string | null;
  session_id?: string | null;
}

export interface WriteSystemLogInput {
  phase: MemoryLogPhase;
  eventType: string;
  level?: MemoryLogLevel;
  message: string;
  detail?: Record<string, unknown> | string | null;
  rolloutId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  ts?: number;
}

/** Resolve the daily JSONL path for a given timestamp (ms). */
export function systemLogPathFor(ts: number, rootDir?: string): string {
  const root = rootDir ?? path.join(os.homedir(), '.duya');
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return path.join(
    root,
    'memory-system-log',
    String(d.getFullYear()),
    pad(d.getMonth() + 1),
    `${pad(d.getDate())}.jsonl`
  );
}

/**
 * Append one event to the memory system log. Best-effort: never throws, so
 * a logging failure cannot break the memory pipeline. The directory is
 * created lazily and the file appended to (O_APPEND semantics).
 */
export function writeSystemLog(input: WriteSystemLogInput, rootDir?: string): void {
  try {
    const ts = input.ts ?? Date.now();
    const entry: MemoryLogEntry = {
      ts,
      phase: input.phase,
      event_type: input.eventType,
      level: input.level ?? 'info',
      message: input.message,
      detail:
        typeof input.detail === 'string' || input.detail === null || input.detail === undefined
          ? null
          : input.detail,
      rollout_id: input.rolloutId ?? null,
      run_id: input.runId ?? null,
      session_id: input.sessionId ?? null,
    };
    const filePath = systemLogPathFor(ts, rootDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging — never break the pipeline on a log write failure.
  }
}

export interface ListSystemLogOpts {
  /** Max entries to return (newest first). Default 200. */
  limit?: number;
  /** Only return entries for this phase. */
  phase?: MemoryLogPhase;
  /** Only return entries for this curation run. */
  runId?: string;
  /** Only return entries at or after this ts (ms). */
  since?: number;
}

export interface ListSystemLogResult {
  entries: MemoryLogEntry[];
  total: number;
}

/**
 * Read the most recent memory system log entries, newest first. Walks the
 * daily JSONL files under <root>/memory-system-log/. Returns an empty
 * list when no log directory exists yet.
 */
export function listSystemLog(opts?: ListSystemLogOpts, rootDir?: string): ListSystemLogResult {
  const limit = opts?.limit ?? 200;
  const root = rootDir ?? path.join(os.homedir(), '.duya');
  const base = path.join(root, 'memory-system-log');
  if (!fs.existsSync(base)) {
    return { entries: [], total: 0 };
  }
  const filePaths = collectDailyFiles(base);
  const entries: MemoryLogEntry[] = [];
  // Walk newest → oldest so we can stop early once we've gathered `limit`.
  for (let i = filePaths.length - 1; i >= 0; i--) {
    const lines = readLines(filePaths[i]);
    for (let j = lines.length - 1; j >= 0; j--) {
      const entry = parseLine(lines[j]);
      if (!entry) continue;
      if (opts?.phase && entry.phase !== opts.phase) continue;
      if (opts?.runId && entry.run_id !== opts.runId) continue;
      if (opts?.since != null && entry.ts < opts.since) continue;
      entries.push(entry);
      if (entries.length >= limit) {
        return { entries, total: countEntries(base) };
      }
    }
  }
  return { entries, total: countEntries(base) };
}

/** Recursively collect every daily JSONL file, sorted by path (date order). */
function collectDailyFiles(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(base);
  return out.sort();
}

function readLines(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLine(line: string): MemoryLogEntry | null {
  try {
    return JSON.parse(line) as MemoryLogEntry;
  } catch {
    return null;
  }
}

function countEntries(base: string): number {
  let total = 0;
  for (const filePath of collectDailyFiles(base)) {
    total += readLines(filePath).length;
  }
  return total;
}
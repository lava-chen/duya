/**
 * Forgetting is durable (framework plan S5).
 *
 * A forgotten fact is retracted at four layers, and this module owns the
 * two that outlive the file:
 *
 *   1. file   — the canonical file flips to `status: retired` (tierWriter),
 *               so recall readers stop returning it.
 *   2. index  — the tier index row is removed (tierWriter), so nothing
 *               rebuildable resurrects the row.
 *   3. gate   — `revision` here is folded into the bot recall revision, so a
 *               frozen prompt snapshot re-renders on the next turn instead
 *               of waiting for the next compaction.
 *   4. extract— the tombstone keys are merged into Stage 1's dedupe set, so
 *               an old conversation summary cannot re-extract the forgotten
 *               fact into the legacy user roots.
 *
 * The ledger is the **write-ahead record** of a forget: it is written
 * BEFORE the file is retired, and it names the file that is being retired.
 * A crash in that window therefore cannot resurrect the fact:
 *
 *   - recall readers skip every tombstoned path, so an un-retired file is
 *     invisible from the moment the ledger lands;
 *   - the startup repair pass (desktop `forgetRecovery`) retires the file
 *     and drops the index row afterwards.
 *
 * The ledger is one small JSON file under the memory root:
 * `<memoryRoot>/.forget-ledger.json`
 *
 *   {
 *     "version": 2,
 *     "revision": 3,
 *     "entries": [
 *       {
 *         "key": "prefers concise answers",
 *         "paths": ["agents/alpha/memory/prefers-concise-answers-0a1b2c3d4e.md"],
 *         "forgottenAt": "2026-10-26T08:00:00.000Z"
 *       }
 *     ]
 *   }
 *
 * `paths` are duya-root-relative with forward slashes — the same shape the
 * tier index stores — while the ledger itself lives in the memory root.
 *
 * Single writer: the Electron main process (tierWriter forget path). Readers
 * are the Host worker (recall revision, tombstoned paths) and the Stage 1
 * extractor (tombstone keys). A missing or corrupt file reads as revision 0
 * / no tombstones — recall then falls back to the retired files, which is
 * still the correct answer.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Ledger filename inside the memory root. */
export const FORGET_LEDGER_FILENAME = '.forget-ledger.json';

const LEDGER_VERSION = 2;

/** One forgotten fact: its dedupe key and the files it was retired from. */
export interface ForgetLedgerEntry {
  /** Normalized dedupe key — blocks re-extraction of the same fact. */
  key: string;
  /** Duya-root-relative canonical file paths (forward slashes). */
  paths: string[];
  /** ISO timestamp of the first forget for this key. */
  forgottenAt: string;
}

/** The durable forget state. */
export interface ForgetLedger {
  /** Monotonic forget counter; 0 when the ledger does not exist yet. */
  revision: number;
  /** Tombstones, sorted by key. */
  entries: ForgetLedgerEntry[];
}

/** One forget to record: the key, and the file it is being retired from. */
export interface ForgetRecord {
  key: string;
  /** Duya-root-relative path of the canonical file (optional). */
  path?: string;
}

const EMPTY_LEDGER: ForgetLedger = { revision: 0, entries: [] };

/** Same normalization the tier writer applies to dedupe keys. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Normalize a ledger path: duya-root-relative, forward slashes, no
 * traversal and no absolute path. Returns null for anything else — a
 * ledger is a local file, but a path still becomes a path segment later.
 */
function normalizeLedgerPath(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
  }
  return segments.join('/');
}

/** `<memoryRoot>/.forget-ledger.json`. */
export function forgetLedgerPath(memoryRoot: string): string {
  return path.join(memoryRoot, FORGET_LEDGER_FILENAME);
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Read the ledger; missing/corrupt/malformed content reads as empty.
 *
 * A version-1 ledger (`{ revision, keys }`, no paths) still reads: its keys
 * keep blocking re-extraction. It carries no path, so nothing is hidden by
 * path until the next forget records one.
 */
export function readForgetLedgerSync(memoryRoot: string): ForgetLedger {
  if (!memoryRoot) return EMPTY_LEDGER;
  let raw: string;
  try {
    raw = fs.readFileSync(forgetLedgerPath(memoryRoot), 'utf8');
  } catch {
    return EMPTY_LEDGER;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LEDGER;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return EMPTY_LEDGER;
  }
  const record = parsed as { revision?: unknown; entries?: unknown; keys?: unknown };
  const entries: ForgetLedgerEntry[] = [];
  if (Array.isArray(record.entries)) {
    for (const rawEntry of record.entries) {
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as { key?: unknown; paths?: unknown; forgottenAt?: unknown };
      const key = typeof entry.key === 'string' ? normalizeKey(entry.key) : '';
      if (!key) continue;
      const paths = Array.isArray(entry.paths)
        ? [...new Set(entry.paths
            .filter((p): p is string => typeof p === 'string')
            .map((p) => normalizeLedgerPath(p))
            .filter((p): p is string => p !== null))]
        : [];
      const forgottenAt = typeof entry.forgottenAt === 'string' ? entry.forgottenAt : '';
      const existing = entries.find((e) => e.key === key);
      if (existing) {
        existing.paths = [...new Set([...existing.paths, ...paths])].sort();
      } else {
        entries.push({ key, paths: paths.sort(), forgottenAt });
      }
    }
  }
  if (Array.isArray(record.keys)) {
    for (const rawKey of record.keys) {
      if (typeof rawKey !== 'string') continue;
      const key = normalizeKey(rawKey);
      if (!key || entries.some((e) => e.key === key)) continue;
      entries.push({ key, paths: [], forgottenAt: '' });
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { revision: positiveInt(record.revision), entries };
}

/** The recall-gate revision alone (what the frozen prompt cache keys on). */
export function readRecallRevisionSync(memoryRoot: string): number {
  return readForgetLedgerSync(memoryRoot).revision;
}

/** Tombstone keys alone (what Stage 1 merges into its dedupe set). */
export function readForgottenKeysSync(memoryRoot: string): string[] {
  return readForgetLedgerSync(memoryRoot)
    .entries.map((entry) => entry.key)
    .filter((key) => key !== '')
    .sort();
}

/**
 * Tombstoned file paths (what recall readers skip). Duya-root-relative,
 * forward slashes — the same shape the tier index stores.
 */
export function readForgottenPathsSync(memoryRoot: string): string[] {
  const paths = new Set<string>();
  for (const entry of readForgetLedgerSync(memoryRoot).entries) {
    for (const entryPath of entry.paths) paths.add(entryPath);
  }
  return [...paths].sort();
}

/**
 * Record one or more forgets: bump `revision` and merge the tombstones.
 *
 * Always bumps, even with no records, so gate-driven forgets still
 * invalidate the frozen snapshot. The write is atomic (temp file + rename)
 * and happens BEFORE the caller mutates the canonical file — that ordering
 * is what makes a crash in the middle recoverable.
 *
 * Throws on write failure: the caller must not report a successful forget
 * whose gate never moved.
 */
export function recordForgetSync(
  memoryRoot: string,
  forgets: readonly ForgetRecord[],
): ForgetLedger {
  const previous = readForgetLedgerSync(memoryRoot);
  const byKey = new Map<string, ForgetLedgerEntry>();
  for (const entry of previous.entries) {
    byKey.set(entry.key, { key: entry.key, paths: [...entry.paths], forgottenAt: entry.forgottenAt });
  }
  const now = new Date().toISOString();
  for (const forget of forgets) {
    const key = normalizeKey(forget.key);
    if (!key) continue;
    const existing = byKey.get(key);
    const paths = existing ? existing.paths : [];
    const relPath = normalizeLedgerPath(forget.path);
    if (relPath && !paths.includes(relPath)) paths.push(relPath);
    byKey.set(key, {
      key,
      paths: paths.sort(),
      forgottenAt: existing?.forgottenAt || now,
    });
  }
  const entries = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const next: ForgetLedger = { revision: previous.revision + 1, entries };
  const file = forgetLedgerPath(memoryRoot);
  fs.mkdirSync(memoryRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: LEDGER_VERSION, ...next }, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  return next;
}

/**
 * Merge the ledger's tombstone keys into a dedupe set. Stage 1 uses this so
 * a forgotten fact stays unknown forever, even when an old summary still
 * contains it.
 */
export function withForgottenKeys(baseKeys: readonly string[], memoryRoot: string): string[] {
  // Base keys keep their original spelling — they come from live files and
  // the extractor has always compared them verbatim. Ledger keys are
  // normalized at write and read time.
  const keys = new Set(baseKeys.filter((k) => typeof k === 'string' && k.trim() !== ''));
  if (memoryRoot) {
    for (const key of readForgottenKeysSync(memoryRoot)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Forgetting is durable (framework plan S5).
 *
 * A forgotten fact is retracted at three layers, and this module owns the
 * two that outlive the file:
 *
 *   1. file   — the canonical file flips to `status: retired` (tierWriter),
 *               so recall readers stop returning it.
 *   2. index  — the tier index row is removed (tierWriter), so nothing
 *               rebuildable resurrects the row.
 *   3. gate   — `revision` here is folded into the bot recall revision, so a
 *               frozen prompt snapshot re-renders on the next turn instead
 *               of waiting for the next compaction.
 *   4. extract— `keys` are merged into Stage 1's dedupe set, so an old
 *               conversation summary cannot re-extract the forgotten fact
 *               into the legacy user roots.
 *
 * The ledger is one small JSON file under the memory root:
 * `<memoryRoot>/.forget-ledger.json`
 *
 * Single writer: the Electron main process (tierWriter forget path). Readers
 * are the Host worker (recall revision) and the Stage 1 extractor (tombstone
 * keys). A missing or corrupt file reads as revision 0 / no keys — recall
 * then falls back to the retired files, which is still the correct answer.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Ledger filename inside the memory root. */
export const FORGET_LEDGER_FILENAME = '.forget-ledger.json';

const LEDGER_VERSION = 1;

export interface ForgetLedger {
  /** Monotonic forget counter; 0 when the ledger does not exist yet. */
  revision: number;
  /** Normalized dedupe keys that must never be re-extracted. */
  keys: string[];
}

const EMPTY_LEDGER: ForgetLedger = { revision: 0, keys: [] };

/** Same normalization the tier writer applies to dedupe keys. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** `<memoryRoot>/.forget-ledger.json`. */
export function forgetLedgerPath(memoryRoot: string): string {
  return path.join(memoryRoot, FORGET_LEDGER_FILENAME);
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Read the ledger; missing/corrupt/malformed content reads as empty. */
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
  const record = parsed as { revision?: unknown; keys?: unknown };
  const keys = Array.isArray(record.keys)
    ? [...new Set(record.keys.filter((k): k is string => typeof k === 'string').map(normalizeKey))]
        .filter((k) => k !== '')
        .sort()
    : [];
  return { revision: positiveInt(record.revision), keys };
}

/** The recall-gate revision alone (what the frozen prompt cache keys on). */
export function readRecallRevisionSync(memoryRoot: string): number {
  return readForgetLedgerSync(memoryRoot).revision;
}

/** Tombstone keys alone (what Stage 1 merges into its dedupe set). */
export function readForgottenKeysSync(memoryRoot: string): string[] {
  return readForgetLedgerSync(memoryRoot).keys;
}

/**
 * Record one forget: bump `revision` and append the forgotten keys.
 * Always bumps, even with no keys, so gate-driven forgets still invalidate
 * the frozen snapshot. Throws on write failure — the caller must not report
 * a successful forget whose gate never moved.
 */
export function recordForgetSync(memoryRoot: string, keys: readonly string[]): ForgetLedger {
  const previous = readForgetLedgerSync(memoryRoot);
  const merged = new Set(previous.keys);
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (normalized) merged.add(normalized);
  }
  const next: ForgetLedger = {
    revision: previous.revision + 1,
    keys: [...merged].sort(),
  };
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

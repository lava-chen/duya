/**
 * file-state - per-file mtime+size tracking for read-dedup
 *
 * When the model reads the same file twice (same offset/limit, same
 * mtime+size) the result is byte-identical to the previous read. We
 * track the last read per file in a Map and surface a "file_unchanged"
 * stub instead of re-sending the full content. Saves ~18% of Read
 * token costs in practice (BQ telemetry from the reference
 * implementation).
 *
 * Only text reads participate (offset is always set). Edit/Write tool
 * results don't go through here. Document mode reads are handled by
 * NodeFileParser's own SHA-256 cache; we leave that path alone so
 * the two layers don't fight.
 *
 * The store is bounded by MAX_ENTRIES (LRU eviction). Without a bound
 * a long-running agent process that reads thousands of distinct files
 * (e.g. a repo-wide Explore pass) would grow the Map indefinitely —
 * each entry holds the full text content of one read, which can be
 * hundreds of KB per file.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface ReadState {
  /** Text content of the last read */
  content: string;
  /** mtime in milliseconds (Math.floor) */
  timestamp: number;
  /** File size in bytes at the time of the last read. Paired with
   *  mtime to detect same-millisecond writes: on fast filesystems
   *  (ext4 with tail-packing, Windows FAT) two writes inside the
   *  same mtime tick produce the same timestamp but almost always a
   *  different size. Without this, the dedup would silently return
   *  the pre-write content. */
  size: number;
  /** Line range used in the last read (undefined = full file) */
  offset: number;
  /** Line range end used in the last read (undefined = no end) */
  limit: number | undefined;
}

export type ReadStateMap = Map<string, ReadState>;

/** Upper bound on the number of tracked files. Picked to cover the
 *  largest realistic single-session read set (a ~10k-file repo audit
 *  reads far fewer unique files than it lists) while keeping memory
 *  under ~50MB worst case. */
const MAX_ENTRIES = 1000;

/**
 * Module-level LRU store, shared across all ReadTool instances in a
 * process. Process restart empties it. JS Map preserves insertion
 * order, so re-inserting an existing key moves it to the end — that
 * gives us LRU semantics for free on access via get + re-set.
 */
const store: ReadStateMap = new Map();

export function getReadStateStore(): ReadStateMap {
  return store;
}

export function clearReadStateStore(): void {
  store.clear();
}

/** Internal: insert/refresh an entry while maintaining the MAX_ENTRIES
 *  bound. Callers should use this instead of `store.set` directly. */
export function setReadState(filePath: string, state: ReadState): void {
  // Move-to-end on refresh so the LRU order reflects recent access.
  if (store.has(filePath)) {
    store.delete(filePath);
  } else if (store.size >= MAX_ENTRIES) {
    // Evict the oldest (first key in insertion order).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
    }
  }
  store.set(filePath, state);
}

/**
 * Stat a file and return its mtime+size fingerprint, or undefined
 * if the file is gone / unreadable. Both fields are checked together
 * by the caller because mtime alone has millisecond-level collisions
 * on fast filesystems.
 */
export function getFileFingerprint(filePath: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = statSync(filePath);
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * SHA-256 of the first 64KB of the file. Used as a fast "did the
 * content change" probe. Distinct from NodeFileParser's hash because
 * that one includes basename+size and is used for cross-tool dedup;
 * this one is file-content-only.
 */
export function computeContentHash(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    const fd = openSync(filePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      hash.update(buffer.subarray(0, bytesRead));
    } finally {
      closeSync(fd);
    }
  } catch {
    // Fall through; the hash is just weaker.
  }
  return hash.digest('hex');
}

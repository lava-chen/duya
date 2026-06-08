/**
 * file-state - per-file mtime tracking for read-dedup
 *
 * When the model reads the same file twice (same offset/limit, same
 * mtime) the result is byte-identical to the previous read. We track
 * the last read per file in a Map and surface a "file_unchanged" stub
 * instead of re-sending the full content. Saves ~18% of Read token
 * costs in practice (BQ telemetry from the reference implementation).
 *
 * Only text reads participate (offset is always set). Edit/Write tool
 * results don't go through here. Document mode reads are handled by
 * NodeFileParser's own SHA-256 cache; we leave that path alone so
 * the two layers don't fight.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface ReadState {
  /** Text content of the last read */
  content: string;
  /** mtime in milliseconds (Math.floor) */
  timestamp: number;
  /** Line range used in the last read (undefined = full file) */
  offset: number;
  /** Line range end used in the last read (undefined = no end) */
  limit: number | undefined;
}

export type ReadStateMap = Map<string, ReadState>;

/**
 * Module-level store, shared across all ReadTool instances in a
 * process. Process restart empties it. Bounded by how many files
 * the user reads in a session.
 */
const store: ReadStateMap = new Map();

export function getReadStateStore(): ReadStateMap {
  return store;
}

export function clearReadStateStore(): void {
  store.clear();
}

/**
 * Stat a file and return its mtime in milliseconds, or undefined
 * if the file is gone / unreadable.
 */
export function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return Math.floor(statSync(filePath).mtimeMs);
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

/**
 * file-read-state.ts - Session-level tracking of file reads (plan 428)
 *
 * The compaction layer replaces older read/bash results over 2000 chars
 * with placeholders. When the model later builds an edit's old_string
 * from that compacted (stale or truncated) view, the edit fails with
 * "old_string not found". Tracking the mtime/size observed at read time
 * lets EditTool refuse edits that are not anchored to a fresh read:
 *
 *   - no record   -> the file was never read in this session
 *   - mtime drift -> the file changed after the last read (bash,
 *                    apply_patch, or an external process)
 *
 * Pure state module: no IO. Callers stat the file and pass the numbers
 * in. Keys are normalized absolute paths so ReadTool (expandPath),
 * EditTool (resolve), and WriteTool (expandPath) all agree on one
 * entry per file even when the raw path strings differ.
 */

import { normalize } from 'node:path';

export interface FileReadStateEntry {
  mtimeMs: number;
  size: number;
}

const readStates = new Map<string, FileReadStateEntry>();

function keyFor(absPath: string): string {
  return normalize(absPath);
}

/** Record (or refresh) the observed state of a file at read/write time. */
export function recordFileRead(absPath: string, entry: FileReadStateEntry): void {
  readStates.set(keyFor(absPath), { mtimeMs: entry.mtimeMs, size: entry.size });
}

/** Get the last observed state for a file, if it was read this session. */
export function getFileReadState(absPath: string): FileReadStateEntry | undefined {
  return readStates.get(keyFor(absPath));
}

/** Drop the recorded state for one file (next edit will demand a re-read). */
export function invalidateFileRead(absPath: string): void {
  readStates.delete(keyFor(absPath));
}

/** Drop all recorded state. Test-only helper. */
export function clearFileReadState(): void {
  readStates.clear();
}

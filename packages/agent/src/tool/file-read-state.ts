/**
 * file-read-state.ts - Session-level tracking of file reads (plan 428, extended by plan 448)
 *
 * The compaction layer replaces older read/bash results over 2000 chars
 * with placeholders. When the model later builds an edit's old_string
 * from that compacted (stale or truncated) view, the edit fails with
 * "old_string not found". Tracking the state observed at read time lets
 * EditTool refuse edits that are not anchored to a fresh read:
 *
 *   - no record   -> the file was never read in this session
 *   - mtime drift -> the file changed after the last read (bash,
 *                    apply_patch, or an external process)
 *
 * Plan 448 adds two fields so EditTool can implement the claude-code-haha
 * style "Windows mtime churn exemption":
 *
 *   - isFullView -> true when the recorded observation covered the whole
 *     file (a full-content read, or a re-anchor right after this session's
 *     own write). A line_range / partial read records false.
 *   - contentSha -> hex sha-256 of the full content when isFullView. When
 *     mtime/size say "stale" but the recorded sha still matches current
 *     disk content, the change was cosmetic (OneDrive/AV touching mtime)
 *     and the edit may proceed.
 *
 * Pure state module: no filesystem IO beyond hashing strings handed to
 * it. Callers stat/read files and pass the numbers in. Keys are normalized
 * absolute paths so ReadTool (expandPath), EditTool (resolve), and
 * WriteTool (expandPath) all agree on one entry per file even when the raw
 * path strings differ.
 */

import { createHash } from 'node:crypto';
import { normalize } from 'node:path';

export interface FileReadStateEntry {
  mtimeMs: number;
  size: number;
  /**
   * True when the recorded observation covered the whole file: a
   * full-content read, or a post-write re-anchor by edit/write/apply_patch.
   * Partial views (line_range reads) must record false — a stale partial
   * view never qualifies for the content-equality exemption.
   */
  isFullView: boolean;
  /** Hex sha-256 of the full content. Only meaningful when isFullView. */
  contentSha?: string;
}

/**
 * Input shape accepted by recordFileRead. isFullView defaults to false
 * (conservative: an unknown view scope never gets the staleness exemption).
 * Callers that know better (full reads, post-write re-anchors) pass true
 * explicitly.
 */
export type FileReadStateInput = {
  mtimeMs: number;
  size: number;
  isFullView?: boolean;
  contentSha?: string;
};

const readStates = new Map<string, FileReadStateEntry>();

function keyFor(absPath: string): string {
  return normalize(absPath);
}

/**
 * Fingerprint used for staleness comparisons: hex sha-256 of the content
 * with any leading UTF-8 BOM removed. Every recorder (read/write/edit/
 * apply_patch) and every verifier must go through this one function —
 * readFile('utf-8') surfaces a BOM as a leading U+FEFF character, and
 * ReadTool strips it from output (plan 448), so comparing raw-content
 * hashes across the two would never match.
 */
export function computeContentSha(content: string): string {
  const core = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return createHash('sha256').update(core, 'utf-8').digest('hex');
}

/** Record (or refresh) the observed state of a file at read/write time. */
export function recordFileRead(absPath: string, entry: FileReadStateInput): void {
  const isFullView = entry.isFullView ?? false;
  readStates.set(keyFor(absPath), {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    isFullView,
    // A partial view must not carry a content fingerprint: EditTool's
    // exemption compares against FULL current content, which a partial
    // view can never vouch for.
    contentSha: isFullView ? entry.contentSha : undefined,
  });
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

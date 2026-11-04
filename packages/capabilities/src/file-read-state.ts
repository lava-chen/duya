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
 *
 * ## Where entries die (plan 448 follow-up)
 *
 * An entry only means "the model saw this content". That claim expires when
 * the context stops carrying the read result, which is not the same thing
 * as "the file did not change":
 *
 *   - summary compaction rewrites the transcript and drops the old read
 *     results -> `clearFileReadState()` from CompactionManager, otherwise
 *     the gate vouches for content the model can no longer see (which is
 *     exactly the 428 bug this module was introduced to prevent).
 *   - a new session in a reused worker process -> `beginFileReadSession()`.
 *   - an external process touching the file -> the freshness check below.
 *
 * ## Gate switch
 *
 * `isReadFirstGateEnabled()` only governs the "never read at all" refusal.
 * Freshness (a real on-disk change since the read) is a data-integrity
 * check and stays unconditional — a stale read is a wrong edit whether or
 * not the gate is on.
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

/**
 * Drop all recorded state.
 *
 * Production callers: summary compaction (the rewrite dropped the read
 * results the entries vouched for) and a new session in a reused worker
 * process. Tests use it for isolation.
 */
export function clearFileReadState(): void {
  readStates.clear();
}

// ---------------------------------------------------------------------------
// Read-first gate switch (plan 448 follow-up)
// ---------------------------------------------------------------------------

/**
 * Default on. Turned off only through `[tools] read_first_gate = false` (or
 * `DUYA_TOOLS_READ_FIRST_GATE=0`), which the worker wires at session init.
 * Module-level because tool execution has no per-call config handle and the
 * process is the session's unit of isolation.
 */
let readFirstGateEnabled = true;

export function setReadFirstGateEnabled(enabled: boolean): void {
  readFirstGateEnabled = enabled;
}

/**
 * Whether a never-read file must be refused. Freshness checks ignore this
 * flag: they protect data integrity, not prompt hygiene.
 */
export function isReadFirstGateEnabled(): boolean {
  return readFirstGateEnabled;
}

// ---------------------------------------------------------------------------
// Session boundary
// ---------------------------------------------------------------------------

let activeSessionKey: string | undefined;

/**
 * Bind the tracker to a session. A *different* session in the same process
 * inherits nothing: entries recorded by the previous session's reads would
 * otherwise vouch for content this session's model never saw. Same-session
 * calls are no-ops so a per-turn call site stays cheap.
 *
 * Deliberately not called for delegated child sessions: they share the
 * parent's process and timeline, and clearing on every child spawn would
 * force the parent to re-read its whole working set.
 */
export function beginFileReadSession(sessionId: string): void {
  if (activeSessionKey === sessionId) return;
  activeSessionKey = sessionId;
  readStates.clear();
}

// ---------------------------------------------------------------------------
// Freshness verdict (shared by every write path)
// ---------------------------------------------------------------------------

/**
 * mtime comparison with a small tolerance. Windows filesystems plus
 * cloud-sync/AV/indexer churn produce meaningless sub-millisecond mtime
 * bumps between two stat() calls. Treat mtimes within 1ms as unchanged;
 * real external edits move mtime by far more.
 */
export function isMtimeWithinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

export type ReadFreshness =
  /** Anchored to an observation that still describes the bytes on disk. */
  | 'fresh'
  /** No entry for this path in the current session. */
  | 'never-read'
  /** An entry exists, but the file drifted since it was recorded. */
  | 'stale';

/**
 * One verdict for every write path, so `edit` and `write` cannot disagree
 * about what "already read" means.
 *
 * `content` must be the CURRENT full file text: the full-view exemption
 * compares the recorded sha against the bytes the caller is about to
 * mutate, and a partial view never qualifies for it.
 */
export function evaluateReadFreshness(
  absPath: string,
  current: { mtimeMs: number; size: number },
  content: string,
): ReadFreshness {
  const entry = readStates.get(keyFor(absPath));
  if (!entry) return 'never-read';

  const mtimeStale = !isMtimeWithinTolerance(entry.mtimeMs, current.mtimeMs);
  const sizeStale = entry.size !== current.size;
  if (!mtimeStale && !sizeStale) return 'fresh';

  // Cosmetic drift: the mtime/size signals moved but the recorded full-file
  // fingerprint still matches. OneDrive sync, AV scans and indexers touch
  // mtime without changing bytes.
  if (entry.isFullView && entry.contentSha !== undefined) {
    if (computeContentSha(content) === entry.contentSha) return 'fresh';
  }
  return 'stale';
}

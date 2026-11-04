/**
 * file-read-state.ts - Session-scoped tracking of file reads (plan 428, extended by plan 448)
 *
 * The compaction layer can drop older read results from the context (summary
 * compaction rewrites the transcript; the legacy projection pass replaced
 * long tool bodies with placeholders). When the model later builds an edit's
 * old_string from that stale or truncated view, the edit fails with
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
 * ## Buckets: one ledger per conversation, not one per process
 *
 * An entry means "THIS model saw this content". A single process-global map
 * made that claim about the whole process, which is wrong in two directions
 * the worker actually exercises:
 *
 *   - delegated child sessions run in the parent's process. A child reading a
 *     file would vouch for it when the PARENT later edits it, even though the
 *     child's read result never enters the parent's context (the parent only
 *     sees the child's final summary). The reverse holds too.
 *   - a reused worker process serves one top-level session after another, and
 *     the second must inherit nothing from the first.
 *
 * So entries live in per-session buckets. Callers pass the session they are
 * acting for — `readScopeFromContext(context)` derives it from the tool call,
 * which carry the calling agent's own session id (a child session's id is a
 * fresh UUID, so parent and child never share a bucket). A call with no scope
 * lands in the active session's bucket, which is what tests and the
 * context-less legacy call paths get.
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
 *   - a new session in a reused worker process -> `beginFileReadSession()`,
 *     which also drops every other bucket.
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

/**
 * Bucket key used when no scope is supplied and no session is active.
 * Distinct from every real session id (those are UUIDs), so an unscoped
 * process-level caller can never read a session's entries.
 */
const UNSCOPED_BUCKET = '';

type Bucket = Map<string, FileReadStateEntry>;

const buckets = new Map<string, Bucket>();

let activeSessionKey: string | undefined;

function keyFor(absPath: string): string {
  return normalize(absPath);
}

function bucketKeyFor(scope: string | undefined): string {
  return scope ?? activeSessionKey ?? UNSCOPED_BUCKET;
}

function findBucket(scope: string | undefined): Bucket | undefined {
  return buckets.get(bucketKeyFor(scope));
}

function ensureBucket(scope: string | undefined): Bucket {
  const key = bucketKeyFor(scope);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = new Map();
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * The scope a tool call should record/verify against: the calling agent's
 * own session, as carried on `ToolUseContext.options.sessionId`.
 *
 * Every read/write path must derive its scope here rather than reading
 * `context.options.sessionId` inline. The four tools disagreeing about the
 * derivation would produce a spurious "File has not been read yet" for a
 * file the same agent just read, which is worse than the gate being off.
 *
 * Typed structurally on purpose: this module is imported by the compaction
 * layer, which must not pull in the tool contracts.
 */
export function readScopeFromContext(
  context?: { options?: { sessionId?: string } },
): string | undefined {
  return context?.options?.sessionId;
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
export function recordFileRead(
  absPath: string,
  entry: FileReadStateInput,
  scope?: string,
): void {
  const isFullView = entry.isFullView ?? false;
  ensureBucket(scope).set(keyFor(absPath), {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    isFullView,
    // A partial view must not carry a content fingerprint: EditTool's
    // exemption compares against FULL current content, which a partial
    // view can never vouch for.
    contentSha: isFullView ? entry.contentSha : undefined,
  });
}

/** Get the last observed state for a file in `scope`, if it was read there. */
export function getFileReadState(
  absPath: string,
  scope?: string,
): FileReadStateEntry | undefined {
  return findBucket(scope)?.get(keyFor(absPath));
}

/** Drop the recorded state for one file (next edit will demand a re-read). */
export function invalidateFileRead(absPath: string, scope?: string): void {
  findBucket(scope)?.delete(keyFor(absPath));
}

/**
 * Drop recorded state.
 *
 * With a `scope`, only that session's ledger is dropped. Without one, every
 * bucket goes — which is what summary compaction needs, because a compaction
 * there means the transcript the entries vouched for is gone, and the cost of
 * over-invalidating is a re-read while the cost of under-invalidating is the
 * 428 wrong edit. Tests use the unscoped form for isolation.
 */
export function clearFileReadState(scope?: string): void {
  if (scope === undefined) {
    buckets.clear();
    return;
  }
  buckets.delete(scope);
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

/**
 * Bind the tracker to a top-level session and drop every other bucket: a
 * different session in the same process inherits nothing. Entries recorded by
 * the previous session's reads would otherwise vouch for content this
 * session's model never saw. Same-session calls are no-ops so a per-turn call
 * site stays cheap, and dropping the other buckets bounds memory across a
 * long-lived worker process.
 *
 * Delegated child sessions do not call this: they run inside the parent's
 * process but get their own bucket through `readScopeFromContext`, so they
 * still cannot borrow the parent's observations — and must not reset the
 * parent's ledger on spawn.
 */
export function beginFileReadSession(sessionId: string): void {
  if (activeSessionKey === sessionId) return;
  activeSessionKey = sessionId;
  buckets.clear();
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
  /** No entry for this path in the calling session's ledger. */
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
  scope?: string,
): ReadFreshness {
  const entry = findBucket(scope)?.get(keyFor(absPath));
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

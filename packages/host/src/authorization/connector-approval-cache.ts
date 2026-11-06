/**
 * AppConnectionTool approvals — a PROCESS-SCOPED, PER-SESSION CACHE of the
 * session's grants (plan 449; scope corrected in plan 587 R2.4; the missing
 * session dimension fixed here).
 *
 * Codex parity: `remember_mcp_tool_approval` keeps per-tool decisions so the
 * user is not re-prompted for the same connector tool within one session.
 *
 * ## This is a cache, and it is NOT the session grant
 *
 * The grant itself lives in `tool_approval_rules`, keyed by
 * `(scope_type, scope_id, tool_name)` -- session id, or bot id on the bot
 * surface. See `worker-process-entry.ts`, which writes the row on
 * `allow_for_session` and seeds this cache from the same read on every
 * `chat:start`. Consequences, stated rather than implied:
 *
 *  - a recycled worker re-reads the grants, so nothing is lost on recycle;
 *  - a grant never outlives its session's row;
 *  - losing this cache costs a cache miss, not the grant.
 *
 * ## Why every entry is keyed by session id
 *
 * The earlier version was a single `Set<string>` of bare tool names, justified
 * by "each duya session runs its own worker process". That was true by
 * COINCIDENCE and nothing enforced it: the same worker process serves
 * several sessions over its life (`permissionScopes` is a Map keyed by
 * session for exactly that reason), so the first worker to serve two sessions
 * handed session B a grant session A earned. A bare set cannot answer "may
 * THIS session run this tool", so it now refuses to answer at all.
 *
 * Global ("always allow") decisions are NOT stored here; they arrive stamped on
 * descriptors (`preApproved`) from the main process.
 */

/** session id -> tool names the user approved for that session. */
const sessionApprovedTools = new Map<string, Set<string>>();

/**
 * Start (or restart) the approval bucket for a session.
 *
 * Called on `chat:start`, before the durable rows are replayed into it: the
 * durable table is authoritative, so a stale in-memory bucket for the same
 * session is dropped rather than merged. Buckets for OTHER sessions are left
 * alone — a worker can serve more than one.
 */
export function beginApprovalSession(sessionId: string): void {
  if (!sessionId) return;
  sessionApprovedTools.set(sessionId, new Set());
}

/** Record a session-wide approval for an app-connection tool name. */
export function rememberSessionApproval(sessionId: string, toolName: string): void {
  if (!sessionId || !toolName) return;
  let bucket = sessionApprovedTools.get(sessionId);
  if (!bucket) {
    bucket = new Set();
    sessionApprovedTools.set(sessionId, bucket);
  }
  bucket.add(toolName);
}

/**
 * Whether this app-connection tool was already approved FOR THIS SESSION.
 *
 * A missing session id is a hard `false`: without the key there is no way to
 * tell whose grant would be answering, and guessing "everyone's" is the bug
 * this function exists to prevent. Callers that cannot name the session get
 * the prompt again, which is the safe direction to fail.
 */
export function isSessionApproved(sessionId: string, toolName: string): boolean {
  if (!sessionId || !toolName) return false;
  return sessionApprovedTools.get(sessionId)?.has(toolName) === true;
}

/**
 * Drop one session's cache, or every session's when called with no argument.
 * The durable rows are untouched either way.
 */
export function clearSessionApprovals(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionApprovedTools.clear();
    return;
  }
  sessionApprovedTools.delete(sessionId);
}

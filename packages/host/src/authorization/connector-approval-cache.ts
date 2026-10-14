/**
 * AppConnectionTool approvals — a PROCESS-SCOPED CACHE of the session's grants
 * (plan 449; scope corrected in plan 587 R2.4).
 *
 * Codex parity: `remember_mcp_tool_approval` keeps per-tool decisions so the
 * user is not re-prompted for the same connector tool within one session.
 *
 * ## This is a cache, and it is NOT the session grant
 *
 * The original header claimed "each duya session runs its own worker process,
 * so process lifetime === session lifetime". That was true by COINCIDENCE and
 * nothing enforced it: the set below is keyed by bare tool name, with no
 * session in the key at all, so the first worker to serve two sessions would
 * hand session B a grant session A earned. Contract §E (R2.4) forbids relying
 * on that coincidence, and the durable row is what backs the grant now.
 *
 * The grant itself lives in `tool_approval_rules`, keyed by
 * `(scope_type, scope_id, tool_name)` -- session id, or bot id on the bot
 * surface. See `process/agent-process-entry.ts`, which writes the row on
 * `allow_for_session` and seeds this cache from the same read on every
 * `chat:start`. Consequences, stated rather than implied:
 *
 *  - a recycled worker re-reads the grants, so nothing is lost on recycle;
 *  - a grant never outlives its session's row;
 *  - losing this cache costs a cache miss, not the grant.
 *
 * Global ("always allow") decisions are NOT stored here; they arrive stamped on
 * descriptors (`preApproved`) from the main process.
 */

const sessionApprovedTools = new Set<string>();

/** Record a session-wide approval for an app-connection tool name. */
export function rememberSessionApproval(toolName: string): void {
  if (toolName) sessionApprovedTools.add(toolName);
}

/** Whether this app-connection tool was already approved this session. */
export function isSessionApproved(toolName: string): boolean {
  return sessionApprovedTools.has(toolName);
}

/** Test/reset helper — clears the cache. The durable rows are untouched. */
export function clearSessionApprovals(): void {
  sessionApprovedTools.clear();
}

/**
 * AppConnectionTool approvals — session-scoped approval memory (Plan 449).
 *
 * Codex parity: `remember_mcp_tool_approval` keeps per-tool decisions so the
 * user is not re-prompted for the same connector tool within one session.
 *
 * Scope: module-level state inside the agent worker process. Each duya session
 * runs its own worker process, so process lifetime === session lifetime — a
 * crash or session end naturally clears the memory. Global ("always allow")
 * decisions are NOT stored here; they arrive stamped on descriptors
 * (`preApproved`) from the main process.
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

/** Test/reset helper — clears all session approvals. */
export function clearSessionApprovals(): void {
  sessionApprovedTools.clear();
}

/**
 * chat-runtime-lock.ts — session runtime lock wiring for the agent-server
 * chat path (Plan 476 P0-A).
 *
 * Background: the agent-server runs as a forked child process; its in-memory
 * `SessionManager` STREAMING state is invisible to the Electron main
 * process. To let main answer "is this session busy right now?" (needed by
 * the idle-wake path, Plan 476 P0-B), we mirror the run lifecycle into the
 * `session_runtime_locks` table (LockStore), which both processes share
 * through db:request IPC.
 *
 * Contract:
 *  - `acquireChatLock` is called right after a chat run actually starts
 *    (worker spawn in handlePostChat). From that moment main sees the
 *    session as busy via `lock:isLocked`;
 *  - `releaseChatLock` is called on terminal paths — the same places that
 *    call `revertStreamingLock()` today (early-return errors) plus the
 *    COMPLETED transition. Because the SSE handler lives in a different
 *    function scope, this module keeps a sessionId → runId map so a release
 *    only needs the sessionId;
 *  - TTL (300s) is the correctness backstop: even if every release is
 *    missed, the row expires and `isLocked`/`acquire` reap it lazily, so a
 *    crash can never wedge a session busy forever.
 *
 * A single module-level map is safe here: the agent-server already
 * serialises runs per session (STREAMING 409), so one session has at most
 * one live chat lock at a time.
 */

export const CHAT_LOCK_OWNER = 'agent-server'
export const CHAT_LOCK_TTL_SEC = 300

export type DbRequest = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>

/** sessionId → runId currently mirrored to the lock table. */
const activeLocks = new Map<string, string>()

function chatLockId(runId: string): string {
  return `chat:${runId}`
}

/**
 * Mirror "this session is running a chat" into session_runtime_locks.
 * Fire-and-forget by design: never fails the chat; TTL keeps the table
 * self-healing. Call once per chat run, right after the worker spawns.
 *
 * `opts.userTurn` (Plan 476 P2.5): true when the request is a direct user
 * message. Main uses it to advance the session's turn_epoch (a new user
 * turn supersedes older background wakes / run tail-effects). Wake and
 * automation runs pass false (or omit it).
 */
export async function acquireChatLock(
  dbRequest: DbRequest,
  sessionId: string,
  opts?: { userTurn?: boolean },
): Promise<void> {
  const runId = crypto.randomUUID()
  activeLocks.set(sessionId, runId)
  try {
    await dbRequest('lock:acquire', {
      sessionId,
      lockId: chatLockId(runId),
      owner: CHAT_LOCK_OWNER,
      ttlSec: CHAT_LOCK_TTL_SEC,
      ...(opts?.userTurn ? { userTurn: true } : {}),
    })
  } catch {
    // Best-effort mirroring — chat must never fail because of the lock.
  }
}

/**
 * Release the runtime lock for a session (if we hold one). Safe to call
 * multiple times / on sessions we never locked: no-op then. Fire-and-forget;
 * TTL is the backstop.
 */
export async function releaseChatLock(
  dbRequest: DbRequest,
  sessionId: string,
): Promise<void> {
  const runId = activeLocks.get(sessionId)
  if (runId == null) return
  activeLocks.delete(sessionId)
  try {
    await dbRequest('lock:release', {
      sessionId,
      lockId: chatLockId(runId),
    })
  } catch {
    // Best-effort; expired rows are reaped by the next acquire/isLocked.
  }
}

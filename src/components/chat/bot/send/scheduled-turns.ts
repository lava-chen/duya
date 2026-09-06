/**
 * scheduled-turns.ts — renderer side of the Plan 500 user-lane dispatch.
 *
 * When a bot is busy, `bot:sendTurn` parks the message on the wake queue's
 * user lane. When the turn's slot arrives, main broadcasts
 * `bot:scheduled-turn`; exactly one renderer window claims it (IPC CAS) and
 * runs the turn through its normal streaming path. This module:
 *  - arbitrates the claim,
 *  - waits for the session's stream to settle first (the preempted run's
 *    SSE may still be draining),
 *  - keeps the captured startStream params for messages queued from THIS
 *    window, so model/effort/mode/files survive the queue hop.
 */

import { canSend } from '../../../../lib/stream-session-manager';

export interface BotScheduledTurnPush {
  sessionId: string;
  agentId: string;
  messageId: string;
  text: string;
  turnEpoch?: number;
}

export interface PendingScheduledTurn {
  sessionId: string;
  content: string;
  displayContent?: string;
  start: () => void;
}

const pendingTurns = new Map<string, PendingScheduledTurn>();

export function rememberPendingTurn(messageId: string, turn: PendingScheduledTurn): void {
  pendingTurns.set(messageId, turn);
}

export function takePendingTurn(messageId: string): PendingScheduledTurn | undefined {
  const turn = pendingTurns.get(messageId);
  pendingTurns.delete(messageId);
  return turn;
}

/**
 * Cancel every turn this window has queued for `sessionId` on the main
 * wake queue (the composer's "clear queued" gesture).
 */
export function cancelPendingTurnsForSession(sessionId: string): void {
  for (const [messageId, turn] of pendingTurns) {
    if (turn.sessionId !== sessionId) continue;
    pendingTurns.delete(messageId);
    void window.electronAPI?.botTurn
      ?.cancelQueuedTurn({ sessionId, messageId })
      .catch(() => { /* best-effort */ });
  }
}

/** Number of turns this window has queued for `sessionId` (sidebar status). */
export function pendingTurnCountForSession(sessionId: string): number {
  let count = 0;
  for (const turn of pendingTurns.values()) {
    if (turn.sessionId === sessionId) count += 1;
  }
  return count;
}

/**
 * Resolve once the session's stream is idle (or the timeout lapses — the
 * caller proceeds and any residual race surfaces as a failed stream).
 */
export async function whenSessionIdle(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (canSend(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * Subscribe to main's scheduled-turn broadcast. Returns an unsubscribe
 * function; no-op unsubscribe when the preload surface is missing.
 */
export function subscribeScheduledTurns(
  onScheduled: (push: BotScheduledTurnPush) => void,
): () => void {
  const api = window.electronAPI?.botTurn;
  if (!api?.onScheduledTurn) return () => {};
  return api.onScheduledTurn((push) => {
    void (async () => {
      // Only the window that wins the claim runs the turn.
      let claimed = false;
      try {
        claimed = await api.claimScheduledTurn({
          sessionId: push.sessionId,
          messageId: push.messageId,
        });
      } catch {
        claimed = false;
      }
      if (!claimed) return;
      await whenSessionIdle(push.sessionId);
      onScheduled(push);
    })();
  });
}

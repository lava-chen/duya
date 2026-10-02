/**
 * tool-approval-resolver.ts — unified decision entry for durable approval
 * cards (plan 498, rakazo-aligned answerRunInput analogue).
 *
 * Flow (mirrors rakazo's `answerRunInput` + `runContinueJob`):
 *   1. CAS the approval row out of `pending` (terminal rows are a no-op —
 *      double-click / late-click can never double-fire).
 *   2. `always` additionally upserts the per-scope always-allow rule
 *      (done inside the store's CAS winner path).
 *   3. Enqueue an `approval.resume` continuation wake so the paused turn's
 *      session learns the decision. Allow/always replays are authorized by
 *      the one-shot ledger (canUseTool consumes the `approved` row on an
 *      exact tool+input-hash match); deny just informs the model.
 *
 * The live-worker fast path is intentionally NOT taken here: the worker's
 * in-memory wait can silently expire (5-minute timeout) between the ask and
 * the click, and a fire-and-forget forward cannot report that. Always going
 * through the ledger keeps the approval sound; the interactive ephemeral
 * prompt (PermissionPrompt / BotPermissionCard over `db:permission:resolve`)
 * remains the low-latency path and syncs card state via `syncApprovalCard`.
 */

import { BrowserWindow } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';

export type ToolApprovalDecisionInput = 'allow' | 'always' | 'deny';

export interface ToolApprovalRowLike {
  id: string;
  message_id: string;
  session_id: string;
  scope_type: 'bot' | 'session';
  scope_id: string;
  tool_name: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied';
  decision: 'allow' | 'always' | 'deny' | null;
}

export interface ToolApprovalResolverDeps {
  /** CAS pending → approved/denied (+ always rule upsert on the winner). */
  resolve: (
    id: string,
    decision: ToolApprovalDecisionInput,
  ) => { row: ToolApprovalRowLike; claimed: boolean } | undefined;
  /** Enqueue the approval.resume continuation wake. */
  enqueueContinuation: (
    row: ToolApprovalRowLike,
    decision: ToolApprovalDecisionInput,
  ) => void;
  /** Best-effort broadcast of the new card state to renderer windows. */
  broadcast: (row: ToolApprovalRowLike) => void;
}

export type ResolveApprovalOutcome =
  | { ok: true; row: ToolApprovalRowLike; firstDecision: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * Apply a user decision to a durable approval card. Idempotent: a terminal
 * row short-circuits with `firstDecision: false` and no continuation.
 */
export function resolveApprovalCard(
  deps: ToolApprovalResolverDeps,
  id: string,
  decision: ToolApprovalDecisionInput,
): ResolveApprovalOutcome {
  const result = deps.resolve(id, decision);
  if (!result) return { ok: false, reason: 'not_found' };

  // `claimed` is the CAS outcome — only the first decision fires the
  // continuation and broadcast (idempotent double-click / late-click guard).
  if (result.claimed) {
    deps.enqueueContinuation(result.row, decision);
    deps.broadcast(result.row);
  }
  return { ok: true, row: result.row, firstDecision: result.claimed };
}

/**
 * Sync hook for the interactive fast path (`db:permission:resolve`): the
 * worker executes immediately via its in-memory pending promise, so the
 * matching card row must transition AND be marked consumed (the replay
 * ledger must never authorize the already-executed call again).
 */
export function syncApprovalCard(
  deps: ToolApprovalResolverDeps & {
    markConsumed: (id: string) => ToolApprovalRowLike | undefined;
  },
  id: string,
  decision: ToolApprovalDecisionInput,
): void {
  try {
    const result = deps.resolve(id, decision);
    if (!result) return;
    if (result.row.status === 'approved') {
      // The live worker executes immediately via its in-memory promise, so
      // burn the ledger entry — a later identical call must not free-ride.
      const consumed = deps.markConsumed(result.row.id);
      if (consumed) {
        deps.broadcast(consumed);
        return;
      }
    }
    deps.broadcast(result.row);
  } catch (err) {
    getLogger().warn(
      'tool approval card sync failed',
      err instanceof Error ? err : new Error(String(err)),
      { id },
      LogComponent.DB,
    );
  }
}

/** Broadcast helper shared by the IPC layer (all renderer windows). */
export function broadcastToolApprovalUpdate(row: ToolApprovalRowLike): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('tool-approval:updated', {
          id: row.id,
          messageId: row.message_id,
          sessionId: row.session_id,
          status: row.status,
          decision: row.decision,
        });
      }
    }
  } catch {
    // Headless boot has no windows.
  }
}

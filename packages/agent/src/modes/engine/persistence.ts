/**
 * ModeTracker persistence — serialization (plan 413a) + disk persistence
 * (plan 413c).
 *
 * The serialization helpers below convert a {@link ModeTracker} to/from the
 * unified {@link ModeStateSnapshot} shape and are deliberately pure: no file
 * system, no DB, no IPC — keeping the migration matrix trivially testable.
 * Plan 413c layers IPC-bound `persistSnapshot` / `restoreTracker` on top: they
 * serialize via the pure helpers and carry the blob over `modeStateDb` IPC to
 * the core-db `mode_state_snapshots` table in the Electron main process.
 */

import type { ModeStateSnapshot, ModeTracker } from './tracker.js';
import { logger } from '../../utils/logger.js';
import { modeStateDb, type ModeStateRow } from '../../ipc/db-client.js';

/** Wrap a tracker's current state into a unified snapshot (plan 413c persists this). */
export function serializeSnapshot(
  tracker: ModeTracker<string, string, unknown>,
  sessionId: string,
  now: number,
): ModeStateSnapshot {
  // Session-scoped read (plan 552): session-aware trackers (goal) return
  // the idle snapshot for a session that does not own the state, so a
  // bystander session can never clobber another session's row with live
  // state — nor persist live state under its own key.
  const data = tracker.snapshot(sessionId) as { state?: unknown } | unknown;
  const dataState =
    data && typeof data === 'object' && 'state' in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).state
      : undefined;
  return {
    mode: tracker.id,
    sessionId,
    status: typeof dataState === 'string' ? dataState : tracker.state(),
    data,
    updatedAt: now,
  };
}

/** Extract the queryable/displayable status string from a snapshot. */
export function snapshotStatus(snap: ModeStateSnapshot): string {
  return snap.status;
}

/**
 * Restore a tracker from a snapshot. Returns whether restoration
 * succeeded; never throws. Invalid input (mismatched mode, null data, or
 * a snapshot the tracker refuses) yields `false` and leaves the tracker
 * untouched.
 */
export function applySnapshot(
  tracker: ModeTracker<string, string, unknown>,
  snap: ModeStateSnapshot,
): boolean {
  if (snap.mode !== tracker.id) return false;
  if (snap.data === null || snap.data === undefined) return false;
  try {
    tracker.restore(snap.data);
    return true;
  } catch {
    // Tracker rejected the snapshot shape — treat as not restorable.
    return false;
  }
}

// ─── Disk persistence (plan 413c) ───────────────────────────────────────────
// IPC-bound wrappers layered on top of the pure serialization helpers above.
// Both degrade on failure (`logger.warn`, never throw) so a DB/IPC hiccup can
// never crash the agent turn loop — mirroring the mailbox claim degradation
// style.

/**
 * Persist the tracker's current state to the `mode_state_snapshots` table.
 * Called after a state transition (plan 413d coordinator round-end). The
 * blob is the full {@link ModeStateSnapshot} (authoritative); `status` and
 * `reminder_count` are mirrored as query redundancy. Any DB/IPC failure is
 * logged and swallowed.
 */
export async function persistSnapshot(
  tracker: ModeTracker<string, string, unknown>,
  sessionId: string,
): Promise<void> {
  try {
    const snap = serializeSnapshot(tracker, sessionId, Date.now());
    await modeStateDb.upsert({
      sessionId,
      mode: snap.mode,
      status: snap.status,
      snapshotJson: JSON.stringify(snap),
      reminderCount: snapshotReminderCount(snap),
    });
    logger.debug(`[ModeTracker] persisted ${tracker.id}/${sessionId} status=${snap.status}`);
  } catch (err) {
    logger.warn(
      `[ModeTracker] persist failed for ${tracker.id}/${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Restore a tracker from the persisted snapshot for a session. Returns
 * whether restoration succeeded. A missing row, unparseable blob, a snapshot
 * the tracker refuses, or a DB/IPC failure all yield `false` and leave the
 * tracker in its initial state.
 */
export async function restoreTracker(
  tracker: ModeTracker<string, string, unknown>,
  sessionId: string,
): Promise<boolean> {
  try {
    const row: ModeStateRow | null = await modeStateDb.get(sessionId, tracker.id);
    if (!row) return false;
    let snap: ModeStateSnapshot;
    try {
      snap = JSON.parse(row.snapshotJson) as ModeStateSnapshot;
    } catch {
      // Corrupt blob — treat as not restorable.
      return false;
    }
    return applySnapshot(tracker, snap);
  } catch (err) {
    logger.warn(
      `[ModeTracker] restore failed for ${tracker.id}/${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Mirror the plan-specific `reminderCount` into the queryable
 * `reminder_count` column when the snapshot payload carries one (plan modes
 * do; other modes default to 0).
 */
function snapshotReminderCount(snap: ModeStateSnapshot): number {
  if (snap.data && typeof snap.data === 'object' && 'reminderCount' in snap.data) {
    const count = (snap.data as { reminderCount?: unknown }).reminderCount;
    if (typeof count === 'number') return count;
  }
  return 0;
}

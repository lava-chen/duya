/**
 * ModeTracker persistence helpers — pure serialization (plan 413a).
 *
 * These functions convert a {@link ModeTracker} to/from the unified
 * {@link ModeStateSnapshot} shape. They are deliberately pure: no file
 * system, no DB, no IPC. Disk persistence is layered on top in plan 413c
 * (`ModeStateStore` + `modeState:*` IPC + `persistSnapshot`/`restoreTracker`).
 * Keeping this layer pure makes the migration matrix trivially testable.
 */

import type { ModeStateSnapshot, ModeTracker } from './tracker.js';

/** Wrap a tracker's current state into a unified snapshot (plan 413c persists this). */
export function serializeSnapshot(
  tracker: ModeTracker<string, string, unknown>,
  sessionId: string,
  now: number,
): ModeStateSnapshot {
  return {
    mode: tracker.id,
    sessionId,
    status: tracker.state(),
    data: tracker.snapshot(),
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

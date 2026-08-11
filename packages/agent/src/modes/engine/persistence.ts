/**
 * ModeTracker snapshot serialization — pure functions (plan 413a).
 *
 * These helpers translate between a {@link ModeTracker} and the uniform
 * {@link ModeStateSnapshot} shape consumed by the coordinator and (later,
 * 413c) the disk / core-db layer. They deliberately touch no I/O — file and
 * database reads/writes live in 413c — so every branch is unit-testable.
 */

import type { ModeStateSnapshot, ModeTracker } from './tracker.js';

/**
 * Wrap a tracker's snapshot into the uniform {@link ModeStateSnapshot} shape.
 *
 * `status` is the tracker's current state string (queryable / displayable);
 * `data` is the full mode-private payload preserved for restore.
 */
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

/**
 * Extract the queryable status string from a snapshot — the value the core-db
 * `status` column stores directly (plan 413c).
 */
export function snapshotStatus(snap: ModeStateSnapshot): string {
  return snap.status;
}

/**
 * Restore a tracker from a snapshot. Returns `false` when the tracker rejects
 * the payload; never throws (an implementation that throws on malformed input
 * is a bug, but a defensive catch keeps the coordinator's recovery path alive).
 */
export function applySnapshot(
  tracker: ModeTracker<string, string, unknown>,
  snap: ModeStateSnapshot,
): boolean {
  try {
    tracker.restore(snap.data);
    return true;
  } catch {
    return false;
  }
}

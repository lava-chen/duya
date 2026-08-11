/**
 * ModeTrackerEngine — registry container for mode state machines (plan 413a).
 *
 * Holds every registered {@link ModeTracker} by id and exposes snapshot
 * collection/restore as the persistence seam. The `trackers` map is
 * typed with `ModeTracker<string, string, unknown>` as a stand-in for an
 * existential type (TS has no true existential); concrete modes register
 * their narrowed trackers by upcasting, and tests assert the narrow type
 * still works at the call site.
 *
 * The engine is a plain class with no async I/O — all persistence reads
 * and writes live in plan 413c.
 */

import type { ModeStateSnapshot, ModeTracker } from './tracker.js';
import { applySnapshot, serializeSnapshot } from './persistence.js';

export class ModeTrackerEngine {
  private trackers = new Map<string, ModeTracker<string, string, unknown>>();

  /** Register a tracker. Throws if `tracker.id` is already taken. */
  register(tracker: ModeTracker<string, string, unknown>): void {
    if (this.trackers.has(tracker.id)) {
      throw new Error(`ModeTracker "${tracker.id}" is already registered`);
    }
    this.trackers.set(tracker.id, tracker);
  }

  has(id: string): boolean {
    return this.trackers.has(id);
  }

  get(id: string): ModeTracker<string, string, unknown> | undefined {
    return this.trackers.get(id);
  }

  /** All registered trackers, in registration order. */
  list(): ModeTracker<string, string, unknown>[] {
    return [...this.trackers.values()];
  }

  /** Collect the persisted snapshot of every registered tracker (plan 413c writes these). */
  snapshots(sessionId: string): ModeStateSnapshot[] {
    return this.list().map((tracker) => serializeSnapshot(tracker, sessionId, Date.now()));
  }

  /**
   * Restore a single tracker from a snapshot. Returns false when no
   * tracker with `snap.mode` is registered, or when the tracker rejects
   * the snapshot. The `sessionId` parameter is reserved for future
   * cross-checks; the authoritative value lives on `snap`.
   */
  restore(sessionId: string, snap: ModeStateSnapshot): boolean {
    void sessionId;
    const tracker = this.trackers.get(snap.mode);
    if (!tracker) return false;
    return applySnapshot(tracker, snap);
  }
}

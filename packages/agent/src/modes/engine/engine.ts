/**
 * ModeTrackerEngine — registration container for mode trackers (plan 413a).
 *
 * Holds one {@link ModeTracker} per stateful mode, mirroring the registration
 * pattern of {@link ModeModifierRegistry}. Concrete trackers register with
 * their narrow generic types and are stored as the existential approximation
 * `ModeTracker<string, string, unknown>` (TS has no true existential types).
 *
 * The engine is the only object with a handle on every tracker, so it is the
 * natural owner of snapshot collection / restore for the persistence layer.
 */

import { applySnapshot, serializeSnapshot } from './persistence.js';
import type { ModeStateSnapshot, ModeTracker } from './tracker.js';

/** Existential approximation used across the engine (see module docs). */
export type AnyModeTracker = ModeTracker<string, string, unknown>;

export class ModeTrackerEngine {
  private trackers = new Map<string, AnyModeTracker>();

  /** Register a tracker. Throws if `tracker.id` is already taken. */
  register(tracker: AnyModeTracker): void {
    if (this.trackers.has(tracker.id)) {
      throw new Error(`ModeTracker "${tracker.id}" is already registered`);
    }
    this.trackers.set(tracker.id, tracker);
  }

  has(id: string): boolean {
    return this.trackers.has(id);
  }

  get(id: string): AnyModeTracker | undefined {
    return this.trackers.get(id);
  }

  list(): AnyModeTracker[] {
    return [...this.trackers.values()];
  }

  /**
   * Collect every registered tracker's persisted snapshot (413c writes these
   * to disk / core-db). `updatedAt` is stamped from the wall clock.
   */
  snapshots(sessionId: string): ModeStateSnapshot[] {
    const now = Date.now();
    return this.list().map((tracker) => serializeSnapshot(tracker, sessionId, now));
  }

  /**
   * Restore a single tracker from a snapshot (413c reads these back on boot).
   * Returns `false` when no tracker matches `snap.mode`, or when the tracker
   * rejects the payload as malformed.
   */
  restore(sessionId: string, snap: ModeStateSnapshot): boolean {
    const tracker = this.trackers.get(snap.mode);
    if (!tracker) return false;
    return applySnapshot(tracker, snap);
  }
}

/**
 * Singleton engine instance. Stateful modes register their trackers against
 * this in `packages/agent/src/modes/index.ts` (plan 413b), mirroring the
 * `modeModifierRegistry` pattern.
 */
export const modeTrackerEngine = new ModeTrackerEngine();

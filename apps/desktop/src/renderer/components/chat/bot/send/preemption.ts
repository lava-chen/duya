/**
 * Plan 491 P1.1: Preemption tracker for bot-direct send strategy.
 *
 * Tracks whether a bot session is busy and allows configuring
 * the busy-time strategy (queue vs preemption).
 */

export type PreemptionStrategy = 'queue' | 'preempt';

/** PreemptionTracker for a single bot session. */
export class PreemptionTracker {
  private busy = false;
  private strategy: PreemptionStrategy = 'queue';

  /**
   * Set the preemption strategy for this session.
   */
  setStrategy(strategy: PreemptionStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Get the current preemption strategy.
   */
  getStrategy(): PreemptionStrategy {
    return this.strategy;
  }

  /**
   * Mark the session as busy (streaming started).
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /**
   * Check if the session is currently busy.
   */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Check if a new message can be sent.
   * Returns true if can send immediately.
   * Returns false if should queue or if preemption is needed.
   */
  canSendImmediately(): boolean {
    if (!this.busy) return true;
    return this.strategy === 'preempt';
  }

  /**
   * Check if a new message should be queued.
   */
  shouldQueue(): boolean {
    if (!this.busy) return false;
    return this.strategy === 'queue';
  }
}

/** Manager for all bot session preemption trackers. */
export class PreemptionManager {
  private trackers = new Map<string, PreemptionTracker>();

  /**
   * Get or create a tracker for a session.
   */
  getTracker(sessionId: string): PreemptionTracker {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new PreemptionTracker();
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /**
   * Remove a tracker when session is destroyed.
   */
  removeTracker(sessionId: string): void {
    this.trackers.delete(sessionId);
  }
}

/** Singleton instance for the application lifetime. */
export const preemptionManager = new PreemptionManager();

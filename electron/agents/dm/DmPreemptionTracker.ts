/**
 * DmPreemptionTracker (Plan 477 P2.1)
 *
 * Tracks which agents have been preempted by a priority DM.
 * When a priority DM is sent via SendToAgent, the target agent is marked as
 * preempted. When the agent is woken up, this state is checked to inject
 * the redrive message into the wake prompt.
 *
 * This is a simple in-memory Set. In a production system, this could be
 * persisted to SQLite, but since preemption is transient (cleared when the
 * agent processes the message), an in-memory Set is sufficient.
 *
 * Based on grok-bot's `dmPreemptedWakeAgentIds` Set in background-wakes.ts.
 */

export class DmPreemptionTracker {
  /**
   * Agents that were preempted by a priority DM and need to be
   * notified of the preemption when they wake up.
   */
  private preemptedAgentIds = new Set<string>();

  /**
   * Mark an agent as preempted by a priority DM.
   */
  markPreempted(agentId: string): void {
    this.preemptedAgentIds.add(agentId);
  }

  /**
   * Check if an agent was preempted.
   */
  isPreempted(agentId: string): boolean {
    return this.preemptedAgentIds.has(agentId);
  }

  /**
   * Clear the preempted state for an agent (called when the agent
   * has been notified and processed the preemption).
   */
  clearPreempted(agentId: string): void {
    this.preemptedAgentIds.delete(agentId);
  }

  /**
   * Get the count of preempted agents (for debugging/monitoring).
   */
  get size(): number {
    return this.preemptedAgentIds.size;
  }
}

/** Singleton instance for the DM preemption tracker. */
export const dmPreemptionTracker = new DmPreemptionTracker();

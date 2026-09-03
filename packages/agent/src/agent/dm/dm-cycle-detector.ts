/**
 * DM Cycle Detector & Send Limiter (Plan 477 P2.2)
 *
 * Tracks active DM exchanges to prevent:
 * 1. Same-pair cycles: A→B when B→A is already in flight
 * 2. Multi-hop cycles: A→B→C→A
 * 3. Flooding: >N messages per run
 *
 * This is a simplified version based on grok-bot's cycle detection patterns.
 * For multi-hop cycles, we track a directed graph of DM edges.
 */

export interface DmEdge {
  from: string; // agent id
  to: string; // agent id
  clientMsgId: string;
  timestampMs: number;
}

/** Simple cycle detector for DM edges. */
export class DmCycleDetector {
  // Directed graph: from → Set<to>
  private edges = new Map<string, Set<string>>();
  // Reverse index: to → Set<from>
  private reverseEdges = new Map<string, Set<string>>();

  /**
   * Add a DM edge (from → to). Returns false if this would create a cycle.
   */
  addEdge(from: string, to: string): boolean {
    // Check for same-pair reverse edge (A→B when B→A exists)
    if (this.hasEdge(to, from)) {
      return false; // Would create A↔B cycle
    }

    // Check for multi-hop cycle: if to can reach from, adding to→from creates a cycle
    if (this.wouldCreateCycle(from, to)) {
      return false;
    }

    // Add the edge
    if (!this.edges.has(from)) {
      this.edges.set(from, new Set());
    }
    this.edges.get(from)!.add(to);

    // Add reverse index
    if (!this.reverseEdges.has(to)) {
      this.reverseEdges.set(to, new Set());
    }
    this.reverseEdges.get(to)!.add(from);

    return true;
  }

  /**
   * Check if edge from → to exists.
   */
  hasEdge(from: string, to: string): boolean {
    return this.edges.get(from)?.has(to) ?? false;
  }

  /**
   * Check if adding edge from → to would create a cycle.
   */
  wouldCreateCycle(from: string, to: string): boolean {
    // If to can already reach from, adding to→from completes a cycle
    return this.canReach(to, from);
  }

  /**
   * Remove an edge (from → to).
   */
  removeEdge(from: string, to: string): void {
    this.edges.get(from)?.delete(to);
    this.reverseEdges.get(to)?.delete(from);
  }

  /**
   * Check if there's a path from source to target in the directed graph.
   */
  private canReach(source: string, target: string): boolean {
    const visited = new Set<string>();
    const queue: string[] = [source];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const neighbors = this.edges.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }

    return false;
  }

  /**
   * Get all agents that from has sent to.
   */
  getSentTo(from: string): string[] {
    return Array.from(this.edges.get(from) ?? []);
  }

  /**
   * Get all agents that have sent to to.
   */
  getReceivedFrom(to: string): string[] {
    return Array.from(this.reverseEdges.get(to) ?? []);
  }

  /** Clear all edges (for testing or reset). */
  clear(): void {
    this.edges.clear();
    this.reverseEdges.clear();
  }
}

/** Per-run send limiter to prevent flooding. */
export class DmSendLimiter {
  // Track send count per run
  private sendCounts = new Map<string, number>();
  private readonly maxPerRun: number;

  constructor(maxPerRun: number = 5) {
    this.maxPerRun = maxPerRun;
  }

  /**
   * Record a send and return true if allowed, false if over limit.
   */
  recordSend(runId: string): boolean {
    const current = this.sendCounts.get(runId) ?? 0;
    if (current >= this.maxPerRun) {
      return false;
    }
    this.sendCounts.set(runId, current + 1);
    return true;
  }

  /**
   * Get the remaining sends for a run.
   */
  remainingSends(runId: string): number {
    const current = this.sendCounts.get(runId) ?? 0;
    return Math.max(0, this.maxPerRun - current);
  }

  /**
   * Check if a run can send (without recording).
   */
  canSend(runId: string): boolean {
    return this.remainingSends(runId) > 0;
  }

  /** Clear all counts (for testing or reset). */
  clear(): void {
    this.sendCounts.clear();
  }

  get max(): number {
    return this.maxPerRun;
  }
}

/** Singleton instances for the current process. */
export const dmCycleDetector = new DmCycleDetector();
export const dmSendLimiter = new DmSendLimiter(5);

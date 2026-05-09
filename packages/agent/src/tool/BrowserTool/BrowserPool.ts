/**
 * BrowserPool - Manages multiple independent browser sessions for parallel investigation.
 * Each session operates a separate browser window/tab independently.
 * Inspired by hermes-agent's per-task session model and openclaw's multi-bridge architecture.
 *
 * Architecture:
 *   BrowserPool
 *   ├── sessions: Map<sessionId, BrowserSession>
 *   │   ├── session_1 → PlaywrightCDPClient → Chromium window 1
 *   │   ├── session_2 → PlaywrightCDPClient → Chromium window 2
 *   │   └── session_3 → PlaywrightCDPClient → Chromium window 3
 *   └── concurrency control via Semaphore (max 5 parallel sessions)
 */

import type { ICDPClient } from './CDPClient.js';
import { PlaywrightCDPClient } from './CDPClient.js';
import { SnapshotEngine } from './SnapshotEngine.js';

export interface InvestigationTask {
  /** Task identifier for result mapping */
  id: string;
  /** URL to investigate */
  url: string;
  /** Optional task description for context-aware investigation */
  task?: string;
  /** Optional CSS selector to focus snapshot on */
  selector?: string;
  /** Optional JavaScript to execute after page load */
  evaluate?: string;
}

export interface InvestigationResult {
  id: string;
  url: string;
  title: string;
  snapshot: string;
  interactiveElements: Array<{
    ref: number;
    tag: string;
    text: string;
  }>;
  evaluateResult?: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface BrowserSession {
  id: string;
  client: ICDPClient;
  snapshotEngine: SnapshotEngine;
  busy: boolean;
}

const MAX_CONCURRENT_SESSIONS = 5;
const SESSION_IDLE_TIMEOUT = 5 * 60 * 1000;

/**
 * Semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(count: number) {
    this.permits = count;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      this.waiting.shift()!();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }
}

/**
 * Manages a pool of browser sessions for parallel web investigation.
 */
export class BrowserPool {
  private sessions = new Map<string, BrowserSession>();
  private semaphore = new Semaphore(MAX_CONCURRENT_SESSIONS);
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;

  /**
   * Investigate multiple URLs in parallel.
   * This is the primary entry point for parallel browser investigation.
   *
   * @param tasks - Array of investigation tasks (URLs with optional context)
   * @param timeoutMs - Per-task timeout in milliseconds (default 30000)
   * @returns Array of investigation results in the same order as tasks
   */
  async investigate(
    tasks: InvestigationTask[],
    timeoutMs = 30000
  ): Promise<InvestigationResult[]> {
    if (this.shuttingDown) {
      throw new Error('BrowserPool is shutting down');
    }

    const results = new Array<InvestigationResult>(tasks.length);
    const pending = tasks.map((task, index) => ({ task, index }));

    // Process in parallel with concurrency control
    const workers = pending.map(async ({ task, index }) => {
      await this.semaphore.acquire();
      try {
        results[index] = await this.investigateSingle(task, timeoutMs);
      } finally {
        this.semaphore.release();
      }
    });

    await Promise.all(workers);
    return results;
  }

  /**
   * Investigate a single URL with a dedicated browser session.
   */
  private async investigateSingle(
    task: InvestigationTask,
    timeoutMs: number
  ): Promise<InvestigationResult> {
    const startTime = Date.now();
    const sessionId = `invest_${task.id}_${Date.now()}`;
    let session: BrowserSession | null = null;

    try {
      session = await this.acquireSession(sessionId);
      const client = session.client;

      const navigateResult = await this.navigateWithTimeout(
        client,
        task.url,
        timeoutMs
      );

      if (!navigateResult.success) {
        return {
          id: task.id,
          url: task.url,
          title: '',
          snapshot: '',
          interactiveElements: [],
          success: false,
          error: navigateResult.error,
          durationMs: Date.now() - startTime,
        };
      }

      const snapshot = await session.snapshotEngine.capture({
        maxLength: task.selector ? 50000 : 100000,
        interactiveOnly: false,
      });

      let evaluateResult: unknown;
      if (task.evaluate) {
        try {
          evaluateResult = await this.evaluateWithTimeout(
            client,
            task.evaluate,
            Math.min(timeoutMs, 10000)
          );
        } catch {
          // Best effort
        }
      }

      return {
        id: task.id,
        url: snapshot.url,
        title: snapshot.title,
        snapshot: snapshot.snapshot,
        interactiveElements: snapshot.interactiveElements.map(el => ({
          ref: el.ref,
          tag: el.tag,
          text: el.text,
        })),
        evaluateResult,
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        id: task.id,
        url: task.url,
        title: '',
        snapshot: '',
        interactiveElements: [],
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (session) {
        this.releaseSession(session);
      }
    }
  }

  /**
   * Acquire or create a browser session.
   */
  private async acquireSession(sessionId: string): Promise<BrowserSession> {
    // Clear idle timer if this session was idle
    const existingTimer = this.idleTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(sessionId);
    }

    // Reuse existing idle session
    for (const [id, session] of this.sessions) {
      if (!session.busy) {
        session.busy = true;
        return session;
      }
    }

    // Create new session
    const client = new PlaywrightCDPClient();
    const snapshotEngine = new SnapshotEngine(client);
    await client.connect();

    const session: BrowserSession = {
      id: sessionId,
      client,
      snapshotEngine,
      busy: true,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Release a session back to the pool.
   */
  private releaseSession(session: BrowserSession): void {
    session.busy = false;

    // Set idle timeout to close session if not reused
    const timer = setTimeout(() => {
      this.closeSession(session.id);
    }, SESSION_IDLE_TIMEOUT);

    this.idleTimers.set(session.id, timer);
  }

  /**
   * Close a specific session and remove it from the pool.
   */
  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }

    try {
      await session.client.close();
    } catch {
      // Best effort
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Navigate with timeout protection.
   */
  private async navigateWithTimeout(
    client: ICDPClient,
    url: string,
    timeoutMs: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await Promise.race([
        client.navigate(url),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Navigation timeout: ${url}`)), timeoutMs)
        ),
      ]);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Navigation failed',
      };
    }
  }

  /**
   * Evaluate with timeout protection.
   */
  private async evaluateWithTimeout(
    client: ICDPClient,
    script: string,
    timeoutMs: number
  ): Promise<unknown> {
    return Promise.race([
      client.evaluate(script),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Evaluation timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Get pool statistics.
   */
  getStats(): {
    totalSessions: number;
    busySessions: number;
    idleSessions: number;
    availablePermits: number;
  } {
    let busyCount = 0;
    let idleCount = 0;
    for (const session of this.sessions.values()) {
      if (session.busy) {
        busyCount++;
      } else {
        idleCount++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      busySessions: busyCount,
      idleSessions: idleCount,
      availablePermits: this.semaphore.available,
    };
  }

  /**
   * Shutdown all sessions and release resources.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Clear all idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Close all sessions
    const closePromises = Array.from(this.sessions.keys()).map(id =>
      this.closeSession(id)
    );
    await Promise.all(closePromises);

    this.sessions.clear();
    this.shuttingDown = false;
  }
}

export default BrowserPool;

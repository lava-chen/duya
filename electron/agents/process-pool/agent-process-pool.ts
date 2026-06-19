/**
 * AgentProcessPool - Multi-process Agent execution with Resource Governor
 *
 * Phase 6: Migrated from electron/agent-process-pool.ts into focused modules.
 *  - process-manager.ts : process lifecycle & resource calculator
 *  - message-router.ts  : message routing between Main and Agent processes
 *  - agent-process-pool.ts (this file) : orchestration & public API
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger.js';
import { getConfigManager, toLLMProvider } from '../../config/manager.js';
import { killProcessTree } from '../../lib/process-cleanup.js';
import { getPerformanceMonitor } from '../../services/performance-monitor.js';

import {
  calculateMaxConcurrent,
  getAgentProcessPath,
  getAgentRuntimeCommand,
  type RunningProcess,
} from './process-manager.js';

import {
  MessageRouter,
  type ProcessMessage,
} from './message-router.js';

export type { ProcessMessage };

export interface AgentProcessConfig {
  sessionId: string;
  maxMemoryMB?: number;
}

export interface QueueItem {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class AgentProcessPool {
  private maxConcurrent: number;
  private running = new Map<string, RunningProcess>();
  private queue: QueueItem[] = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private busySessions = new Set<string>();
  private interruptedSessions = new Set<string>();
  private pendingMessages = new Map<string, { prompt: string; options?: Record<string, unknown> }[]>();
  private debugIpc = process.env.DUYA_DEBUG_IPC === 'true';
  private logger = getLogger();
  private providerReinitLock = new Map<string, boolean>();
  private unsubConfigChange: (() => void) | null = null;
  private router = new MessageRouter();

  constructor() {
    this.maxConcurrent = calculateMaxConcurrent();
    this.startHeartbeat();
    this.subscribeToProviderChanges();
  }

  private subscribeToProviderChanges(): void {
    const configManager = getConfigManager();
    this.unsubConfigChange = configManager.onConfigChange(() => {
      for (const sessionId of this.running.keys()) {
        this.reinitProcess(sessionId);
      }
    });
  }

  // ========================================================================
  // Process Lifecycle
  // ========================================================================

  /**
   * Pin a session to a specific provider id. Subsequent
   * `sendProviderInit` calls for this session will use that
   * provider instead of the global default. Pass `null` to clear
   * the per-session pin and fall back to the global default.
   *
   * The pin is applied at the next re-initialization boundary
   * (start, post-busy idle, or config-change). It does NOT
   * interrupt an in-flight turn.
   */
  setSessionProvider(sessionId: string, providerId: string | null): void {
    const proc = this.running.get(sessionId);
    if (!proc) {
      // Session not yet started; cache the pin so startProcess
      // picks it up. We store it on the pool itself.
      if (providerId !== null) {
        this.pendingProviderPins.set(sessionId, providerId);
      } else {
        this.pendingProviderPins.delete(sessionId);
      }
      return;
    }
    if (proc.providerId === providerId) return;
    proc.providerId = providerId;
    this.pendingProviderPins.delete(sessionId);
    this.reinitProcess(sessionId);
  }

  /** Per-session pin queued before the session was started. */
  private pendingProviderPins = new Map<string, string>();

  async acquire(sessionId: string): Promise<{ isNew: boolean }> {
    if (this.isShuttingDown) {
      throw new Error('Process pool is shutting down');
    }

    if (this.running.has(sessionId)) {
      return { isNew: false };
    }

    if (this.running.size < this.maxConcurrent) {
      await this.startProcess(sessionId);
      return { isNew: true };
    } else {
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ sessionId, resolve, reject });
      });
      return { isNew: true };
    }
  }

  isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  markSessionBusy(sessionId: string): void {
    this.busySessions.add(sessionId);
  }

  markSessionIdle(sessionId: string): void {
    this.busySessions.delete(sessionId);
  }

  queueMessage(sessionId: string, prompt: string, options?: Record<string, unknown>): void {
    if (!this.pendingMessages.has(sessionId)) {
      this.pendingMessages.set(sessionId, []);
    }
    this.pendingMessages.get(sessionId)!.push({ prompt, options });
  }

  drainNextMessage(sessionId: string): { prompt: string; options?: Record<string, unknown> } | undefined {
    const queue = this.pendingMessages.get(sessionId);
    if (!queue || queue.length === 0) {
      this.pendingMessages.delete(sessionId);
      return undefined;
    }
    const msg = queue.shift()!;
    if (queue.length === 0) {
      this.pendingMessages.delete(sessionId);
    }
    return msg;
  }

  hasPendingMessages(sessionId: string): boolean {
    const queue = this.pendingMessages.get(sessionId);
    return !!queue && queue.length > 0;
  }

  private async startProcess(sessionId: string): Promise<void> {
    const agentPath = getAgentProcessPath();
    const configManager = getConfigManager();
    const securityBypassSkills = configManager.getConfig().securityBypassSkills || [];
    const runtime = getAgentRuntimeCommand(sessionId, securityBypassSkills);

    return new Promise((resolve, reject) => {
      try {
        const child: ChildProcess = spawn(runtime.command, runtime.args, {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: runtime.env,
        });

        const runningProcess: RunningProcess = {
          child,
          startTime: Date.now(),
          lastPong: Date.now(),
          sessionId,
          // Apply any pin that was queued before this session
          // was actually started; otherwise default to null
          // (i.e. use the global default).
          providerId: this.pendingProviderPins.get(sessionId) ?? null,
        };
        this.pendingProviderPins.delete(sessionId);

        this.logger.info(`Agent process started: ${runtime.command} ${runtime.args.join(' ')}`, undefined, LogComponent.AgentProcessPool);

        // Capture stderr for debugging - output in real-time + buffer for exit logging
        const stderrChunks: string[] = [];
        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => {
            const line = chunk.toString();
            // Real-time output to console
            process.stderr.write(`[agent:${sessionId.slice(0, 8)}] ${line}`);
            stderrChunks.push(line);
          });
        }

        child.on('message', async (msg: ProcessMessage) => {
          await this.router.handleMessage(sessionId, msg, runningProcess);
          if (msg.type === 'pong') {
            runningProcess.lastPong = Date.now();
          }
        });

        child.on('error', (err: Error) => {
          this.logger.error('Spawn error', err, { sessionId }, LogComponent.AgentProcessPool);
          this.release(sessionId);
          reject(err);
        });

        child.on('exit', (code, signal) => {
          // Log captured stderr for debugging
          if (stderrChunks.length > 0) {
            this.logger.error('Agent process stderr', undefined, {
              sessionId,
              stderr: stderrChunks.slice(0, 5).join('\n'),
            }, LogComponent.AgentProcessPool);
          }

          const isCrash = code !== 0 || signal;
          if (isCrash) {
            this.logger.error('Process exited unexpectedly', undefined, { sessionId, code, signal }, LogComponent.AgentProcessPool);
          }

          this.router.broadcastDisconnect(sessionId, code, signal);
          this.router.clearSession(sessionId);
          this.running.delete(sessionId);
          this.busySessions.delete(sessionId);
          this.providerReinitLock.delete(sessionId);

          if (!isCrash) {
            this.pendingMessages.delete(sessionId);
          }

          this.processQueue();
        });

        this.running.set(sessionId, runningProcess);
        this.logger.info(`Process registered for session ${sessionId}`, undefined, LogComponent.AgentProcessPool);
        resolve();
      } catch (err) {
        this.logger.error('Failed to start process', err instanceof Error ? err : new Error(String(err)), {
          sessionId, runtimeCommand: runtime.command,
        }, LogComponent.AgentProcessPool);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  release(sessionId: string): void {
    const proc = this.running.get(sessionId);
    if (proc) {
      void killProcessTree(proc.child, { force: true });
      this.running.delete(sessionId);
    }

    this.busySessions.delete(sessionId);
    this.interruptedSessions.delete(sessionId);
    this.providerReinitLock.delete(sessionId);
    this.router.clearSession(sessionId);

    const remainingQueue: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.sessionId === sessionId) {
        item.reject(new Error(`Process released for session ${sessionId}`));
      } else {
        remainingQueue.push(item);
      }
    }
    this.queue = remainingQueue;
    this.processQueue();
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;
    if (this.running.size >= this.maxConcurrent) return;

    const next = this.queue.shift();
    if (!next) return;

    this.startProcess(next.sessionId)
      .then(() => next.resolve())
      .catch(err => next.reject(err));
  }

  // ========================================================================
  // Message API
  // ========================================================================

  send(sessionId: string, msg: ProcessMessage): boolean {
    const proc = this.running.get(sessionId);
    if (!proc || proc.child.exitCode !== null) {
      return false;
    }

    try {
      proc.child.send(msg);
      return true;
    } catch (err) {
      return false;
    }
  }

  onMessage(sessionId: string, handler: (msg: ProcessMessage) => void): void {
    this.router.register(sessionId, handler);
  }

  removeMessageHandler(sessionId: string, handler?: (msg: ProcessMessage) => void): void {
    this.router.remove(sessionId, handler);
  }

  // ========================================================================
  // Health Monitoring
  // ========================================================================

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.checkAllProcesses();
    }, 10000);
  }

  private checkAllProcesses(): void {
    const now = Date.now();
    const timeout = 120000;
    const pingThreshold = 60000;

    for (const [sessionId, proc] of this.running) {
      if (proc.child.exitCode !== null) {
        this.running.delete(sessionId);
        this.busySessions.delete(sessionId);
        this.interruptedSessions.delete(sessionId);
        this.providerReinitLock.delete(sessionId);
        this.router.clearSession(sessionId);
        this.processQueue();
        continue;
      }

      const elapsed = now - proc.lastPong;
      if (elapsed > timeout) {
        this.logger.warn('Process timed out, killing', { sessionId, elapsed, timeout }, LogComponent.AgentProcessPool);
        this.router.broadcastDisconnect(sessionId, null, null);
        void killProcessTree(proc.child, { force: true });
        this.running.delete(sessionId);
        this.busySessions.delete(sessionId);
        this.interruptedSessions.delete(sessionId);
        this.providerReinitLock.delete(sessionId);
        this.router.clearSession(sessionId);
        this.processQueue();
      } else if (elapsed > pingThreshold) {
        try {
          proc.child.send({ type: 'ping' });
        } catch {
          this.running.delete(sessionId);
          this.busySessions.delete(sessionId);
          this.interruptedSessions.delete(sessionId);
          this.providerReinitLock.delete(sessionId);
          this.router.clearSession(sessionId);
          this.processQueue();
        }
      }
    }
  }

  // ========================================================================
  // Stats
  // ========================================================================

  getStatus(): {
    running: number;
    maxConcurrent: number;
    queueLength: number;
    processes: Array<{ sessionId: string; uptime: number; lastPong: number }>;
  } {
    const now = Date.now();
    return {
      running: this.running.size,
      maxConcurrent: this.maxConcurrent,
      queueLength: this.queue.length,
      processes: Array.from(this.running.values()).map(p => ({
        sessionId: p.sessionId,
        uptime: now - p.startTime,
        lastPong: p.lastPong,
      })),
    };
  }

  isRunning(sessionId: string): boolean {
    const proc = this.running.get(sessionId);
    return proc !== undefined && proc.child.exitCode === null;
  }

  interrupt(sessionId: string): boolean {
    const proc = this.running.get(sessionId);
    if (!proc) return false;

    // Use this.send() (which calls proc.child.send) — NOT this.router.send(),
    // which doesn't exist on MessageRouter. MessageRouter only routes
    // inbound messages FROM the child process to registered handlers;
    // it has no outbound send capability.
    this.send(sessionId, { type: 'chat:interrupt', sessionId });
    this.interruptedSessions.add(sessionId);
    return true;
  }

  getInterruptedSessions(): string[] {
    return Array.from(this.interruptedSessions);
  }

  clearInterruptedSession(sessionId: string): void {
    this.interruptedSessions.delete(sessionId);
  }

  waitForReady(sessionId: string, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeMessageHandler(sessionId, readyHandler);
        reject(new Error(`Agent process ${sessionId} ready timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const readyHandler = (msg: ProcessMessage) => {
        const msgType = (msg as { type?: string }).type;
        if (msgType === 'ready' || msgType === 'conductor:ready') {
          clearTimeout(timeout);
          this.removeMessageHandler(sessionId, readyHandler);
          resolve();
        }
      };
      this.onMessage(sessionId, readyHandler);
    });
  }

  // ========================================================================
  // Provider Re-initialization
  // ========================================================================

  private reinitProcess(sessionId: string): void {
    if (this.providerReinitLock.get(sessionId)) {
      return;
    }

    const proc = this.running.get(sessionId);
    if (!proc || proc.child.exitCode !== null) return;

    if (this.busySessions.has(sessionId)) {
      this.providerReinitLock.set(sessionId, true);
      const handlerSet = this.router.getHandlers(sessionId);
      if (handlerSet) {
        const checkDone = (msg: ProcessMessage): void => {
          const msgType = (msg as { type?: string }).type;
          if (msgType === 'chat:done' || msgType === 'chat:error') {
            handlerSet.delete(checkDone);
            this.providerReinitLock.delete(sessionId);
            this.sendProviderInit(sessionId);
          }
        };
        handlerSet.add(checkDone);
      }
      return;
    }

    this.sendProviderInit(sessionId);
  }

  private sendProviderInit(sessionId: string): void {
    const configManager = getConfigManager();
    // Per-thread pin wins over the global default. With the
    // multi-provider model, every session can be pinned to a
    // specific provider id via `setSessionProvider`. When the
    // pin is null (or the pin targets a deleted provider), we
    // fall back to the user's soft default.
    const proc = this.running.get(sessionId);
    const pinnedId = proc?.providerId ?? null;
    const pinned = pinnedId ? configManager.getAllProviders()[pinnedId] : undefined;
    const target = pinned ?? configManager.getDefaultProvider();
    if (!target) {
      this.logger.warn(
        `sendProviderInit: no provider for session ${sessionId} ` +
          `(pinnedId=${pinnedId}, defaultId=${configManager.getConfig().defaultProviderId ?? 'null'})`,
        undefined,
        LogComponent.AgentProcessPool,
      );
      return;
    }

    const providerConfig = {
      apiKey: target.apiKey,
      baseURL: target.baseUrl,
      model: target.options?.defaultModel || target.options?.model || '',
      provider: toLLMProvider(target.providerType),
      authStyle: 'api_key' as const,
    };

    this.send(sessionId, {
      type: 'init',
      sessionId,
      providerConfig,
      systemLocation: {
        locale: app.getLocale(),
        localeCountryCode: app.getLocaleCountryCode(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  // ========================================================================
  // Shutdown
  // ========================================================================

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.unsubConfigChange) {
      this.unsubConfigChange();
      this.unsubConfigChange = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [sessionId] of this.running) {
      this.router.broadcastDisconnect(sessionId, null, null);
    }

    const killPromises: Promise<void>[] = [];
    for (const [, proc] of this.running) {
      killPromises.push(killProcessTree(proc.child, { force: true }));
    }
    await Promise.all(killPromises);

    const remaining = Array.from(this.running.entries());
    for (const [sessionId] of remaining) {
      this.router.clearSession(sessionId);
    }

    this.running.clear();
    this.busySessions.clear();
    this.interruptedSessions.clear();
    this.providerReinitLock.clear();
    this.pendingMessages.clear();

    for (const item of this.queue) {
      item.reject(new Error('Process pool shutdown'));
    }
    this.queue = [];
  }
}

// ========================================================================
// Singleton
// ========================================================================

let processPool: AgentProcessPool | null = null;

export function getAgentProcessPool(): AgentProcessPool {
  if (!processPool) {
    processPool = new AgentProcessPool();
  }
  return processPool;
}

export function initAgentProcessPool(): AgentProcessPool {
  if (processPool) {
    return processPool;
  }
  processPool = new AgentProcessPool();
  return processPool;
}
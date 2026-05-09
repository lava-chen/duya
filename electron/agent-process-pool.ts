/**
 * AgentProcessPool - Multi-process Agent execution with Resource Governor
 *
 * Features:
 * - Process pool with configurable max concurrency
 * - Dynamic resource-aware concurrency limiting
 * - Per-process health monitoring with heartbeat
 * - Message routing between Main and Agent processes
 * - Queue management for sessions waiting for available slots
 *
 * Architecture:
 * Main Process ──► AgentProcessPool ──► Agent Processes (one per session)
 *
 * Message Flow:
 * 1. Agent Process emits message
 * 2. Main receives via IPC
 * 3. Forwarded to Renderer via IPC (streaming, in-memory only)
 * 4. On stream completion, Agent Process sends message:replace via db:request
 *    which atomically persists all messages to SQLite (full replace)
 *
 * Resource Governor:
 * 1. Process-level: maxConcurrent based on CPU cores and free memory
 * 2. Tool-level: TokenBucket for I/O rate limiting (in agent process)
 * 3. Health: Heartbeat monitoring with automatic zombie kill
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { handleDbRequest } from './ipc/agent-communicator.js';
import * as os from 'os';
import { app } from 'electron';
import { getLogger, LogComponent } from './logger.js';
import { getConfigManager } from './config-manager.js';
import { killProcessTree } from './lib/process-cleanup.js';
import { getDatabase } from './db-handlers.js';
import { getPerformanceMonitor } from './performance-monitor.js';

// =============================================================================
// Types & Interfaces
// =============================================================================

export interface AgentProcessConfig {
  sessionId: string;
  maxMemoryMB?: number;
}

export interface ProcessMessage {
  type: string;
  [key: string]: unknown;
}

export interface RunningProcess {
  child: ChildProcess;
  startTime: number;
  lastPong: number;
  sessionId: string;
}

export interface QueueItem {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

// =============================================================================
// Resource Calculator
// =============================================================================

/**
 * Calculate max concurrent agent processes based on system resources
 * - CPU cores / 2
 * - Only if free memory > 2GB
 */
function calculateMaxConcurrent(): number {
  const cpuCores = os.cpus().length;
  const freeMemBytes = os.freemem();
  const freeMemGB = freeMemBytes / (1024 * 1024 * 1024);

  const baseLimit = Math.floor(cpuCores / 2);
  const memoryLimit = freeMemGB > 2 ? 4 : 2;

  const maxConcurrent = Math.min(baseLimit, memoryLimit);
  getLogger().info('Resource calculation', { cpuCores, freeMemGB: freeMemGB.toFixed(1), maxConcurrent }, LogComponent.AgentProcessPool);

  return Math.max(maxConcurrent, 1); // At least 1
}

// =============================================================================
// AgentProcessPool Class
// =============================================================================

export class AgentProcessPool {
  private maxConcurrent: number;
  private running = new Map<string, RunningProcess>();
  private queue: QueueItem[] = [];
  private messageHandlers = new Map<string, Set<(msg: ProcessMessage) => void>>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private busySessions = new Set<string>();
  private pendingMessages = new Map<string, { prompt: string; options?: Record<string, unknown> }[]>();
  private debugIpc = process.env.DUYA_DEBUG_IPC === 'true';
  private logger = getLogger();
  private providerReinitLock = new Map<string, boolean>();
  private unsubConfigChange: (() => void) | null = null;

  constructor() {
    this.maxConcurrent = calculateMaxConcurrent();
    this.startHeartbeat();
    this.subscribeToProviderChanges();
  }

  private subscribeToProviderChanges(): void {
    const configManager = getConfigManager();
    this.unsubConfigChange = configManager.onConfigChange(() => {
      this.logger.info('Provider config changed, re-initializing running processes', {
        runningCount: this.running.size,
      }, LogComponent.AgentProcessPool);
      for (const sessionId of this.running.keys()) {
        this.reinitProcess(sessionId);
      }
    });
  }

  // =========================================================================
  // Process Lifecycle
  // =========================================================================

  /**
   * Get the agent process entry path
   */
  private getAgentProcessPath(): string {
    // In dev: packages/agent/dist/process/agent-process-entry.js
    // In prod: electron-builder copies packages/agent/dist/** to resources/agent/**
    // so the entry becomes resources/agent/process/agent-process-entry.js.
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'agent-bundle', 'agent-process-entry.js');
      if (fs.existsSync(bundled)) return bundled;

      const primary = path.join(process.resourcesPath, 'agent', 'process', 'agent-process-entry.js');
      if (fs.existsSync(primary)) return primary;

      // Backward-compat fallback for previously expected layout.
      const fallback = path.join(process.resourcesPath, 'agent', 'dist', 'process', 'agent-process-entry.js');
      return fallback;
    }

    const devBundled = path.join(process.cwd(), 'packages', 'agent', 'bundle', 'agent-process-entry.js');
    if (fs.existsSync(devBundled)) return devBundled;

    return path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
  }

  /**
   * Resolve the runtime command used to start agent subprocess.
   * In production, do not rely on system `node` existing in PATH.
   */
  private getAgentRuntimeCommand(sessionId: string, securityBypassSkills?: string[]): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    const agentPath = this.getAgentProcessPath();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUYA_AGENT_MODE: 'true',
      SESSION_ID: sessionId,
      DUYA_SECURITY_BYPASS_SKILLS: securityBypassSkills?.join(',') || '',
    };

    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [agentPath],
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
          DUYA_BETTER_SQLITE3_PATH: path.join(process.resourcesPath, 'better-sqlite3'),
        },
      };
    }

    // Development mode: use Electron's Node.js runtime for consistent ABI
    // This ensures better-sqlite3 native module compatibility
    return {
      command: process.execPath,
      args: [agentPath],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        DUYA_BETTER_SQLITE3_PATH: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
      },
    };
  }

  /**
   * Acquire a process slot for a session
   * If no slots available, queue the session
   */
  async acquire(sessionId: string): Promise<{ isNew: boolean }> {
    if (this.isShuttingDown) {
      throw new Error('Process pool is shutting down');
    }

    if (this.running.has(sessionId)) {
      this.logger.info(`Session ${sessionId} already running`, undefined, LogComponent.AgentProcessPool);
      return { isNew: false };
    }

    if (this.running.size < this.maxConcurrent) {
      await this.startProcess(sessionId);
      return { isNew: true };
    } else {
      // Queue and wait
      this.logger.info(`Session ${sessionId} queued`, { running: this.running.size, maxConcurrent: this.maxConcurrent }, LogComponent.AgentProcessPool);
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

  /**
   * Queue a message for a busy session
   */
  queueMessage(sessionId: string, prompt: string, options?: Record<string, unknown>): void {
    if (!this.pendingMessages.has(sessionId)) {
      this.pendingMessages.set(sessionId, []);
    }
    this.pendingMessages.get(sessionId)!.push({ prompt, options });
    this.logger.info('Message queued', { sessionId, queueSize: this.pendingMessages.get(sessionId)!.length }, LogComponent.AgentProcessPool);
  }

  /**
   * Drain and return the next queued message for a session
   * Returns undefined if queue is empty (caller should NOT start a new turn)
   */
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
    this.logger.info('Message drained', { sessionId, remaining: queue.length }, LogComponent.AgentProcessPool);
    return msg;
  }

  /**
   * Check if a session has pending messages
   */
  hasPendingMessages(sessionId: string): boolean {
    const queue = this.pendingMessages.get(sessionId);
    return !!queue && queue.length > 0;
  }

  /**
   * Start a new agent process for a session
   */
  private async startProcess(sessionId: string): Promise<void> {
    const agentPath = this.getAgentProcessPath();
    this.logger.info('Starting process', { sessionId, agentPath, agentPathExists: fs.existsSync(agentPath) }, LogComponent.AgentProcessPool);

    // Get security bypass list from config
    const configManager = getConfigManager();
    const securityBypassSkills = configManager.getConfig().securityBypassSkills || [];

    const runtime = this.getAgentRuntimeCommand(sessionId, securityBypassSkills);
    this.logger.info('Runtime command', { command: runtime.command }, LogComponent.AgentProcessPool);
    this.logger.info('Starting process', {
      sessionId,
      agentPath,
      agentPathExists: fs.existsSync(agentPath),
      runtimeCommand: runtime.command,
      runtimeArgs: runtime.args,
      cwd: process.cwd(),
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
    }, LogComponent.AgentProcessPool);

    return new Promise((resolve, reject) => {
      try {
        const child = spawn(runtime.command, runtime.args, {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: runtime.env,
        });

        this.logger.info('Process spawned', { sessionId, pid: child.pid }, LogComponent.AgentProcessPool);

        const runningProcess: RunningProcess = {
          child,
          startTime: Date.now(),
          lastPong: Date.now(),
          sessionId,
        };

        // Capture stdout/stderr for debugging
        child.stdout?.on('data', (data) => {
          this.logger.debug(`stdout: ${data.toString().trim()}`, { sessionId }, LogComponent.AgentProcess);
        });
        child.stderr?.on('data', (data) => {
          const stderrLine = data.toString().trim();
          this.logger.error('AgentProcess stderr', undefined, { sessionId, stderr: stderrLine }, LogComponent.AgentProcess);
        });

        // Set up message handler
        child.on('message', async (msg: ProcessMessage) => {
          await this.handleProcessMessage(sessionId, msg);
        });

        // Handle process errors
        child.on('error', (err) => {
          this.logger.error('Spawn error', err, {
            sessionId,
            runtimeCommand: runtime.command,
            runtimeArgs: runtime.args,
          }, LogComponent.AgentProcessPool);
          this.release(sessionId);
          reject(err);
        });

        // Handle process exit
        child.on('exit', (code, signal) => {
          if (code !== 0 || signal) {
            this.logger.error('Process exited unexpectedly', undefined, {
              sessionId,
              code,
              signal,
              runtimeCommand: runtime.command,
              runtimeArgs: runtime.args,
            }, LogComponent.AgentProcessPool);
          } else {
            this.logger.info('Process exited normally', { sessionId, code, signal }, LogComponent.AgentProcessPool);
          }
          const handlers = this.messageHandlers.get(sessionId);
          this.running.delete(sessionId);
          this.busySessions.delete(sessionId);
          this.messageHandlers.delete(sessionId);
          this.providerReinitLock.delete(sessionId);
          this.pendingMessages.delete(sessionId);

          // If crashed unexpectedly, notify and release slot
          if (!this.isShuttingDown) {
            // Notify message handlers about disconnect
            if (handlers) {
              for (const handler of handlers) {
                handler({ type: 'process:disconnected', code, signal } as ProcessMessage);
              }
            }
          }

          this.processQueue();
        });

        this.running.set(sessionId, runningProcess);
        console.log(`[AgentProcessPool] Process registered for session ${sessionId}`);
        resolve();

      } catch (err) {
        console.error(`[AgentProcessPool] Failed to start process for ${sessionId}:`, err);
        this.logger.error('Failed to start process', err instanceof Error ? err : new Error(String(err)), {
          sessionId,
          runtimeCommand: runtime.command,
          runtimeArgs: runtime.args,
        }, 'AgentProcessPool');
        reject(err);
      }
    });
  }

  /**
   * Release a process slot and start next queued session
   */
  release(sessionId: string): void {
    const proc = this.running.get(sessionId);
    if (proc) {
      void killProcessTree(proc.child, { force: true });
      this.running.delete(sessionId);
    }

    // Remove from queue if pending
    this.queue = this.queue.filter(item => item.sessionId !== sessionId);

    // Process next in queue
    this.processQueue();
  }

  /**
   * Process the queue and start next waiting session
   */
  private processQueue(): void {
    if (this.queue.length === 0) return;
    if (this.running.size >= this.maxConcurrent) return;

    const next = this.queue.shift();
    if (!next) return;

    this.startProcess(next.sessionId)
      .then(() => next.resolve())
      .catch(err => next.reject(err));
  }

  // =========================================================================
  // Message Routing
  // =========================================================================

  /**
   * Send message to a specific session's agent process
   */
  send(sessionId: string, msg: ProcessMessage): boolean {
    const proc = this.running.get(sessionId);
    if (!proc || proc.child.exitCode !== null) {
      console.warn(`[AgentProcessPool] Cannot send to ${sessionId}: process not running`);
      return false;
    }

    try {
      proc.child.send(msg);
      return true;
    } catch (err) {
      console.error(`[AgentProcessPool] Send failed for ${sessionId}:`, err);
      return false;
    }
  }

  /**
   * Register message handler for a session
   */
  onMessage(sessionId: string, handler: (msg: ProcessMessage) => void): void {
    let handlers = this.messageHandlers.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.messageHandlers.set(sessionId, handlers);
    }
    handlers.add(handler);
  }

  /**
   * Remove message handler for a session
   */
  removeMessageHandler(sessionId: string, handler?: (msg: ProcessMessage) => void): void {
    if (handler) {
      const handlers = this.messageHandlers.get(sessionId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.messageHandlers.delete(sessionId);
        }
      }
    } else {
      this.messageHandlers.delete(sessionId);
    }
  }

  /**
   * Handle incoming message from agent process
   * Messages are forwarded to the handler (Renderer) immediately.
   * Persistence is handled by the Agent Process via message:replace after stream completion.
   */
  private async handleProcessMessage(sessionId: string, msg: ProcessMessage): Promise<void> {
    const proc = this.running.get(sessionId);
    if (proc) {
      proc.lastPong = Date.now();
    }

    if (msg.type === 'pong') {
      // Heartbeat response, handled by heartbeat monitor
      return;
    }

    // Handle DB requests from Agent process
    if (msg.type === 'db:request') {
      if (this.debugIpc) {
        console.log('[AgentProcessPool][DEBUG] db:request', {
          sessionId,
          action: (msg as { action?: string }).action,
          id: (msg as { id?: string }).id,
        });
      }
      try {
        const response = await handleDbRequest(msg as unknown as { type: 'db:request'; id: string; action: string; payload: unknown });
        const child = proc?.child;
        if (child && !child.killed) {
          child.send(response);
          if (this.debugIpc) {
            console.log('[AgentProcessPool][DEBUG] db:response', {
              sessionId,
              action: (msg as { action?: string }).action,
              id: (msg as { id?: string }).id,
              success: response.success,
            });
          }
        } else {
          console.error('[AgentProcessPool] FAILED to send db:response: child is', child ? 'killed' : 'undefined');
        }
      } catch (error) {
        console.error('[AgentProcessPool] handleDbRequest failed:', error);
        const child = proc?.child;
        if (child && !child.killed) {
          child.send({
            type: 'db:response',
            id: (msg as unknown as { id: string }).id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }

    // Handle title generation from agent process
    if (msg.type === 'chat:title_generated') {
      const titleMsg = msg as unknown as { sessionId: string; title: string };
      try {
        const db = getDatabase();
        if (db) {
          db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(titleMsg.title, titleMsg.sessionId);
          this.logger.info('Session title updated', { sessionId: titleMsg.sessionId, title: titleMsg.title }, LogComponent.AgentProcessPool);
        }
      } catch (err) {
        this.logger.error('Failed to update session title', err instanceof Error ? err : new Error(String(err)), { sessionId: titleMsg.sessionId }, LogComponent.AgentProcessPool);
      }
      // Also forward to handlers so renderer can update UI
      const handlers = this.messageHandlers.get(sessionId);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg);
        }
      }
      return;
    }

    // === Forward to handlers ===
    const handlers = this.messageHandlers.get(sessionId);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg);
      }
    } else {
      console.warn(`[AgentProcessPool] No handler for session ${sessionId}, message:`, msg.type);
    }

    // Record memory snapshot on turn completion
    if (msg.type === 'chat:done' || msg.type === 'chat:error') {
      getPerformanceMonitor().recordTurnMemory(sessionId);
    }
  }

  // =========================================================================
  // Resource Governor - Health Monitoring
  // =========================================================================

  /**
   * Start heartbeat monitoring
   * Sends ping every 10s, kills process if no pong within 5s
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.checkAllProcesses();
    }, 10000);
  }

  /**
   * Check all running processes and kill unresponsive ones
   */
  private checkAllProcesses(): void {
    const now = Date.now();
    const timeout = 120000; // 120 seconds for pong response (must be > DB request timeout of 30s)
    const pingThreshold = 60000; // Send ping if no recent response (60s threshold)

    for (const [sessionId, proc] of this.running) {
      if (proc.child.exitCode !== null) {
        // Process already dead
        console.log(`[AgentProcessPool] Cleaning up dead process: ${sessionId}`);
        this.running.delete(sessionId);
        continue;
      }

      const elapsed = now - proc.lastPong;
      if (elapsed > timeout) {
        console.warn(`[AgentProcessPool] Process ${sessionId} unresponsive (${elapsed}ms since last pong), killing`);
        void killProcessTree(proc.child, { force: true });
        this.running.delete(sessionId);
        this.processQueue();
      } else if (elapsed > pingThreshold) {
        // Send ping if no recent response (60s threshold)
        try {
          proc.child.send({ type: 'ping' });
        } catch {
          // Process is dead
          this.running.delete(sessionId);
        }
      }
    }
  }

  // =========================================================================
  // Stats & Info
  // =========================================================================

  /**
   * Get current pool status
   */
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

  /**
   * Check if a session is running
   */
  isRunning(sessionId: string): boolean {
    const proc = this.running.get(sessionId);
    return proc !== undefined && proc.child.exitCode === null;
  }

  /**
   * Wait for agent process to emit 'ready' signal
   * Call after acquire() + sending 'init'
   */
  waitForReady(sessionId: string, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeMessageHandler(sessionId, readyHandler);
        reject(new Error(`Agent process ${sessionId} ready timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      // Use a one-time handler to capture 'ready' or 'conductor:ready'
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

  // =========================================================================
  // Provider Re-initialization
  // =========================================================================

  /**
   * Re-initialize an agent process with the current provider config.
   * If the process is busy, the re-init will be deferred until chat:done/chat:error.
   */
  private reinitProcess(sessionId: string): void {
    if (this.providerReinitLock.get(sessionId)) {
      this.logger.info('Reinit already pending for session', { sessionId }, LogComponent.AgentProcessPool);
      return;
    }

    const proc = this.running.get(sessionId);
    if (!proc || proc.child.exitCode !== null) return;

    if (this.busySessions.has(sessionId)) {
      this.logger.info('Deferring reinit for busy session', { sessionId }, LogComponent.AgentProcessPool);
      this.providerReinitLock.set(sessionId, true);
      const handlerSet = this.messageHandlers.get(sessionId);
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

  /**
   * Build and send init message with current provider config to an agent process
   */
  private sendProviderInit(sessionId: string): void {
    const configManager = getConfigManager();
    const activeProvider = configManager.getActiveProvider();
    if (!activeProvider) {
      this.logger.warn('No active provider configured, skipping reinit', { sessionId }, LogComponent.AgentProcessPool);
      return;
    }

    const providerConfig = {
      apiKey: activeProvider.apiKey,
      baseURL: activeProvider.baseUrl,
      model: activeProvider.options?.defaultModel || activeProvider.options?.model || '',
      provider: toLLMProvider(activeProvider.providerType),
      authStyle: 'api_key' as const,
    };

    this.logger.info('Sending reinit to agent process', { sessionId, provider: providerConfig.provider, model: providerConfig.model }, LogComponent.AgentProcessPool);

    this.send(sessionId, {
      type: 'init',
      sessionId,
      providerConfig,
    });
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  /**
   * Shutdown all processes and stop the pool.
   * Returns a Promise that resolves when all processes have been terminated.
   */
  async shutdown(): Promise<void> {
    console.log('[AgentProcessPool] Shutting down...');
    this.isShuttingDown = true;

    if (this.unsubConfigChange) {
      this.unsubConfigChange();
      this.unsubConfigChange = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Kill all running processes and wait for termination
    const killPromises: Promise<void>[] = [];
    for (const [sessionId, proc] of this.running) {
      this.logger.info('Killing process', { sessionId }, LogComponent.AgentProcessPool);
      killPromises.push(killProcessTree(proc.child, { force: true }));
    }
    await Promise.all(killPromises);
    this.running.clear();

    // Reject all queued items
    for (const item of this.queue) {
      item.reject(new Error('Process pool shutdown'));
    }
    this.queue = [];

    this.logger.info('Shutdown complete', undefined, LogComponent.AgentProcessPool);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let processPool: AgentProcessPool | null = null;

export function getAgentProcessPool(): AgentProcessPool {
  if (!processPool) {
    processPool = new AgentProcessPool();
  }
  return processPool;
}

export function initAgentProcessPool(): AgentProcessPool {
  if (processPool) {
    console.warn('[AgentProcessPool] Already initialized');
    return processPool;
  }
  processPool = new AgentProcessPool();
  return processPool;
}

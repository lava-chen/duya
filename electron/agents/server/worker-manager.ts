import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './session-store';
import { SessionState } from './types';
import { workerLogger } from './logger';
import { getWorkerMaxMemoryMB, getWorkerIdleTtlMs, isLowPowerEnv, selectIdleSessionIds } from './worker-limits';

export function createWorkerEnvironment(
  sessionId: string,
  maxMemoryMB: number,
  betterSqlite3Path: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SESSION_ID: sessionId,
    DUYA_AGENT_MODE: 'true',
    DUYA_AGENT_SERVER: 'true',
    // The BrowserTool uses this as the signal that it can open and drive the
    // built-in WebView through the Browser Daemon. Omitting it silently routes
    // Agent Server workers to static fallback mode.
    DUYA_DAEMON_PORT: process.env.DUYA_DAEMON_PORT ?? '19825',
    DUYA_BETTER_SQLITE3_PATH: process.env.DUYA_BETTER_SQLITE3_PATH || betterSqlite3Path,
    DUYA_CUSTOM_DB_PATH: process.env.DUYA_CUSTOM_DB_PATH,
    NODE_OPTIONS: `--max-old-space-size=${maxMemoryMB}`,
  };
}

export class WorkerManager {
  private workers = new Map<string, ChildProcess>();
  private sessionManager: SessionManager;
  private onWorkerCrash: ((sessionId: string) => void) | null = null;
  private onWorkerMessage: ((sessionId: string, msg: Record<string, unknown>) => void) | null = null;
  // H6: Track intentionally killed workers so their exit is not misjudged as a crash
  private intentionalKills = new WeakSet<ChildProcess>();
  // Plan 426 Phase 2: idle recycling. lastActivityAt refreshes on every
  // inbound worker message and every outbound command; the reaper kills
  // settled workers whose last activity is older than the TTL.
  private lastActivity = new Map<string, number>();
  private keepAliveSessions = new Set<string>();
  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lowPower = isLowPowerEnv();
  // In-flight background sub-agent count per worker process (reported by the
  // agent process via `background_tasks:update`). While the session total is
  // > 0 the session's worker is exempt from idle reaping and its replacement
  // is deferred, because the sub-agents execute inside that worker process.
  private backgroundInFlightByWorker = new Map<ChildProcess, number>();
  // Old workers kept alive solely to drain in-flight background sub-agents
  // after a new chat replaced them. Killed when the count hits 0 or the
  // deadline passes.
  private drainingWorkers = new Map<string, { child: ChildProcess; deadline: number }>();
  /** Hard cap for a draining worker that never settles (60 min). */
  private static readonly DRAIN_MAX_MS = 60 * 60 * 1000;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  setCrashHandler(handler: (sessionId: string) => void): void {
    this.onWorkerCrash = handler;
  }

  setMessageHandler(handler: (sessionId: string, msg: Record<string, unknown>) => void): void {
    this.onWorkerMessage = handler;
  }

  spawnWorker(sessionId: string): ChildProcess {
    // Create new worker BEFORE killing old one, so workers map stays populated during transition
    const oldChild = this.workers.get(sessionId);
    const workerPath = this.resolveWorkerPath();

    if (!fs.existsSync(workerPath)) {
      throw new Error(`Worker entry not found: ${workerPath}`);
    }

    const maxMemoryMB = getWorkerMaxMemoryMB();

    const env = createWorkerEnvironment(
      sessionId,
      maxMemoryMB,
      this.resolveBetterSqlite3Path(),
    );

    const child = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as any,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      execPath: process.execPath,
    });

    const workerPid = child.pid;
    workerLogger.info('Worker spawned', {
      sessionId,
      pid: workerPid,
      workerPath,
      maxMemoryMB,
      betterSqlite3Path: env.DUYA_BETTER_SQLITE3_PATH,
    });

    this.workers.set(sessionId, child);
    this.lastActivity.set(sessionId, Date.now());

    // C5: Transition state after worker is registered. The caller may have already
    // transitioned (e.g. handlePostChat uses transitionState as a concurrency lock),
    // so wrap in try/catch to avoid throwing if the transition is invalid.
    try {
      this.sessionManager.transitionState(sessionId, SessionState.STREAMING);
    } catch (err) {
      workerLogger.warn('transitionState(STREAMING) skipped', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Now handle the old worker: background sub-agents run inside it, so a
    // replacement must not kill them mid-run. Defer the kill until the agent
    // reports zero in-flight tasks (or the drain deadline expires).
    if (oldChild) {
      if ((this.backgroundInFlightByWorker.get(oldChild) ?? 0) > 0) {
        this.deferWorkerKill(sessionId, oldChild);
      } else {
        this.killWorkerImpl(sessionId, oldChild);
      }
    }

    child.on('exit', (code, signal) => {
      // Only clean up if this child is still the current worker for this session
      const current = this.workers.get(sessionId);
      if (current !== child) {
        workerLogger.info('Worker exit ignored (stale, already replaced)', { sessionId, pid: workerPid });
        return;
      }
      this.workers.delete(sessionId);
      this.lastActivity.delete(sessionId);
      this.backgroundInFlightByWorker.delete(child);
      // A draining (deferred) worker may still run background sub-agents for
      // this session — keep the reaper exemption until those drain too.
      if (this.sessionInFlight(sessionId) === 0) {
        this.keepAliveSessions.delete(sessionId);
      }

      const exitedCleanly = code === 0;
      const exitedBySignal = code === null && signal !== null;
      // H6: Intentionally killed workers (e.g. via killWorker/interruptWorker) should
      // not be misjudged as crashes on Windows where child.kill() produces non-zero exit.
      const isIntentionalKill = this.intentionalKills.has(child);

      if (exitedCleanly) {
        workerLogger.info('Worker exited normally', { sessionId, pid: workerPid });
      } else if (exitedBySignal || isIntentionalKill) {
        workerLogger.info('Worker terminated by signal', { sessionId, pid: workerPid, signal, intentional: isIntentionalKill });
      } else {
        workerLogger.warn('Worker exited with error code', { sessionId, pid: workerPid, exitCode: code, signal });
      }

      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        const isRealCrash = !isIntentionalKill && typeof code === 'number' && code > 0 && session.state !== SessionState.COMPLETED;
        if (isRealCrash) {
          try {
            this.sessionManager.transitionState(sessionId, SessionState.CRASHED);
          } catch {
            // State transition may be invalid if session already moved on
          }
          workerLogger.error('Worker crash detected', undefined, { sessionId, exitCode: code, signal });
          if (this.onWorkerCrash) {
            this.onWorkerCrash(sessionId);
          }
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      // Direct output to console for debugging - this is from agent process
      console.error(`[worker:${sessionId.slice(0, 8)}] ${line}`);

      // Parse log level from message - worker uses [LEVEL] prefix
      if (line.startsWith('[ERROR]') || line.includes('Error:')) {
        workerLogger.error('Worker stderr', new Error(line), { sessionId, pid: workerPid });
      } else if (line.startsWith('[WARN]') || line.startsWith('[WARNING]')) {
        workerLogger.warn('Worker stderr', { sessionId, pid: workerPid, message: line });
      } else if (line.startsWith('[INFO]') || line.startsWith('[DEBUG]')) {
        workerLogger.info('Worker stderr', { sessionId, pid: workerPid, message: line });
      } else {
        // Unknown format - log as info to avoid false ERROR alerts
        workerLogger.info('Worker stderr', { sessionId, pid: workerPid, message: line });
      }
    });

    child.on('message', (msg: Record<string, unknown>) => {
      this.lastActivity.set(sessionId, Date.now());
      // Control-plane: the agent process reports background sub-agent counts
      // so the reaper keeps this worker alive while sub-agents run and drops
      // the exemption (and kills any deferred old worker) once they drain.
      if (msg.type === 'background_tasks:update') {
        const inFlight = typeof msg.inFlight === 'number' && Number.isFinite(msg.inFlight)
          ? Math.max(0, Math.floor(msg.inFlight))
          : 0;
        this.backgroundInFlightByWorker.set(child, inFlight);
        // Session total spans the current worker and any draining (deferred)
        // worker; a stale zero from one worker must not drop the exemption
        // while the other still runs sub-agents.
        const sessionTotal = this.sessionInFlight(sessionId);
        if (sessionTotal > 0) {
          this.keepAliveSessions.add(sessionId);
        } else {
          this.keepAliveSessions.delete(sessionId);
          this.killDrainingWorker(sessionId);
        }
        return;
      }
      // db:request, conductor:executor:rpc, appConnection:invoke, and
      // appConnection:listDescriptors are handled by the per-request handlers
      // in router.ts (they forward to main process). All other messages go
      // to the centralized handler (used by InteragentRouter).
      if (msg.type === 'db:request' || msg.type === 'conductor:executor:rpc' || msg.type === 'appConnection:invoke' || msg.type === 'appConnection:listDescriptors') {
        return;
      }
      if (this.onWorkerMessage) {
        this.onWorkerMessage(sessionId, msg);
      }
    });

    child.on('error', (err) => {
      workerLogger.error('Worker process error', err, { sessionId, pid: workerPid });
    });
    return child;
  }

  killWorker(sessionId: string): void {
    const child = this.workers.get(sessionId);
    if (!child) return;
    // A worker with in-flight background sub-agents must not be killed
    // outright (interagent cleanup, session teardown) — defer the kill so
    // the sub-agents can finish and deliver their notifications. The idle
    // reaper never reaches this branch for in-flight workers (keepAlive).
    if ((this.backgroundInFlightByWorker.get(child) ?? 0) > 0) {
      this.deferWorkerKill(sessionId, child);
      return;
    }
    this.killWorkerImpl(sessionId, child);
  }

  /**
   * Keep an old worker alive (outside the workers map) so its in-flight
   * background sub-agents can finish after a replacement worker took over
   * the session. The worker is killed when the agent reports zero in-flight
   * tasks (see the `background_tasks:update` handler) or when the drain
   * deadline passes, whichever comes first.
   */
  private deferWorkerKill(sessionId: string, child: ChildProcess): void {
    this.intentionalKills.add(child);
    this.drainingWorkers.set(sessionId, { child, deadline: Date.now() + WorkerManager.DRAIN_MAX_MS });
    workerLogger.info('Worker replacement deferred (background sub-agents in flight)', {
      sessionId,
      pid: child.pid,
    });
    // Hard deadline: never leak a stuck draining worker forever.
    const timer = setTimeout(() => {
      if (this.drainingWorkers.get(sessionId)?.child !== child) return;
      this.drainingWorkers.delete(sessionId);
      workerLogger.warn('Draining worker deadline exceeded, force killing', { sessionId, pid: child.pid });
      child.kill('SIGKILL');
    }, WorkerManager.DRAIN_MAX_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => {
      if (this.drainingWorkers.get(sessionId)?.child === child) {
        this.drainingWorkers.delete(sessionId);
      }
      this.backgroundInFlightByWorker.delete(child);
    });
  }

  /** Total in-flight background sub-agents across all workers of a session. */
  private sessionInFlight(sessionId: string): number {
    let total = 0;
    const current = this.workers.get(sessionId);
    if (current) total += this.backgroundInFlightByWorker.get(current) ?? 0;
    const draining = this.drainingWorkers.get(sessionId);
    if (draining) total += this.backgroundInFlightByWorker.get(draining.child) ?? 0;
    return total;
  }

  /** Kill the deferred old worker for a session once its tasks drained. */
  private killDrainingWorker(sessionId: string): void {
    const entry = this.drainingWorkers.get(sessionId);
    if (!entry) return;
    this.drainingWorkers.delete(sessionId);
    workerLogger.info('Killing drained replacement worker', { sessionId, pid: entry.child.pid });
    this.killWorkerImpl(sessionId, entry.child);
  }

  interruptWorker(sessionId: string, graceMs = 2000): boolean {
    const child = this.workers.get(sessionId);
    if (!child) return false;

    const sent = this.sendCommand(sessionId, { type: 'chat:interrupt', sessionId });
    workerLogger.info('Worker interrupt requested', {
      sessionId,
      pid: child.pid,
      sent,
      graceMs,
    });

    const timeout = setTimeout(() => {
      if (this.workers.get(sessionId) === child) {
        workerLogger.warn('Worker still present after interrupt grace period, terminating', {
          sessionId,
          pid: child.pid,
        });
        this.killWorkerImpl(sessionId, child);
      }
    }, graceMs);

    child.once('exit', () => {
      clearTimeout(timeout);
    });

    return true;
  }

  // Internal kill that accepts the child directly, used by spawnWorker during replace
  private killWorkerImpl(sessionId: string, child: ChildProcess): void {
    workerLogger.info('Killing worker', { sessionId, pid: child.pid });
    // H6: Mark this child as intentionally killed so the spawnWorker exit handler
    // does not misjudge it as a crash (especially on Windows).
    this.intentionalKills.add(child);
    let exited = false;
    const forceKillTimeout = setTimeout(() => {
      if (!exited) {
        workerLogger.warn('Worker did not exit after termination signal, force killing', {
          sessionId,
          pid: child.pid,
        });
        child.kill('SIGKILL');
      }
    }, 3000);

    // M11: Single once('exit') listener handles both timeout cleanup and map deletion
    child.once('exit', () => {
      exited = true;
      clearTimeout(forceKillTimeout);
      if (this.workers.get(sessionId) === child) {
        this.workers.delete(sessionId);
        workerLogger.info('Worker terminated', { sessionId });
      }
      this.lastActivity.delete(sessionId);
      this.backgroundInFlightByWorker.delete(child);
      // Only drop the reaper exemption when no worker of this session still
      // runs background sub-agents (a draining worker's exit must not clear
      // the exemption of a current worker with in-flight tasks).
      if (this.sessionInFlight(sessionId) === 0) {
        this.keepAliveSessions.delete(sessionId);
      }
    });

    if (process.platform === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');
    }
  }

  sendCommand(sessionId: string, cmd: Record<string, unknown>): boolean {
    const child = this.workers.get(sessionId);
    if (!child || child.killed || !child.stdin) {
      workerLogger.warn('Worker not available for command', { sessionId, commandType: cmd.type, hasWorker: !!child, killed: child?.killed, hasStdin: !!child?.stdin });
      return false;
    }

    workerLogger.debug('Sending command to worker', { sessionId, commandType: cmd.type });
    this.lastActivity.set(sessionId, Date.now());
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (err) {
      // C2: stdin.write can throw if the pipe is closed (worker exiting)
      workerLogger.warn('Failed to write command to worker stdin', {
        sessionId,
        commandType: cmd.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  }

  broadcastCommand(cmd: Record<string, unknown>): number {
    let count = 0;
    for (const [sessionId] of this.workers) {
      if (this.sendCommand(sessionId, cmd)) {
        count++;
      }
    }
    workerLogger.info('Broadcast command to workers', { commandType: cmd.type, workerCount: count });
    return count;
  }

  /**
   * Plan 426 Phase 2.3: per-session exemption from idle reaping. Use for
   * sessions whose worker must survive idle periods (cron/shared sessions,
   * long-lived subagent parents). The mark is cleared automatically when
   * the worker exits.
   */
  setKeepAlive(sessionId: string, enabled: boolean): void {
    if (enabled) this.keepAliveSessions.add(sessionId);
    else this.keepAliveSessions.delete(sessionId);
  }

  isKeepAlive(sessionId: string): boolean {
    return this.keepAliveSessions.has(sessionId);
  }

  /** Test/inspection hook: last activity timestamp for a session's worker. */
  getLastActivity(sessionId: string): number | undefined {
    return this.lastActivity.get(sessionId);
  }

  /**
   * Plan 426 Phase 2.2: start the periodic idle reaper. Default check
   * interval 30s; workers idle past the TTL (10min default, 4min in
   * lowPower) are killed — later requests go through the existing
   * lazy-spawn path.
   */
  startIdleReaper(checkIntervalMs = 30_000): void {
    if (this.idleReaperTimer) return;
    this.idleReaperTimer = setInterval(() => this.reapIdleWorkers(), checkIntervalMs);
  }

  stopIdleReaper(): void {
    if (this.idleReaperTimer) {
      clearInterval(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }
  }

  private reapIdleWorkers(): void {
    if (this.workers.size === 0) return;
    const ttlMs = getWorkerIdleTtlMs(this.lowPower);
    const now = Date.now();
    const candidates = Array.from(this.workers.keys()).map((sessionId) => ({
      sessionId,
      lastActivityAt: this.lastActivity.get(sessionId),
      keepAlive: this.keepAliveSessions.has(sessionId),
      state: this.sessionManager.getSession(sessionId)?.state,
    }));
    for (const sessionId of selectIdleSessionIds(candidates, now, ttlMs)) {
      const child = this.workers.get(sessionId);
      if (!child) continue;
      // A kill is already in flight (killWorkerImpl marked it) — wait for
      // the exit event instead of stacking duplicate kill attempts.
      if (this.intentionalKills.has(child)) continue;
      const idleMs = now - (this.lastActivity.get(sessionId) ?? now);
      workerLogger.info('Reaping idle worker', { sessionId, pid: child.pid, idleMs, ttlMs, lowPower: this.lowPower });
      this.killWorker(sessionId);
    }
  }

  getWorker(sessionId: string): ChildProcess | undefined {
    return this.workers.get(sessionId);
  }

  hasWorker(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }

  get workerCount(): number {
    return this.workers.size;
  }

  private resolveWorkerPath(): string {
    const isPackaged = !!process.resourcesPath && !process.defaultApp;

    if (isPackaged) {
      const bundled = path.join(process.resourcesPath, 'agent-bundle', 'agent-process-entry.js');
      if (fs.existsSync(bundled)) {
        return bundled;
      }

      const primary = path.join(process.resourcesPath, 'agent', 'process', 'agent-process-entry.js');
      if (fs.existsSync(primary)) {
        return primary;
      }

      const fallback = path.join(process.resourcesPath, 'agent', 'dist', 'process', 'agent-process-entry.js');
      if (fs.existsSync(fallback)) {
        return fallback;
      }
    }

    // Prefer the esbuild bundle over tsc-compiled dist.
    // The dist output is ESM with runtime imports that resolve to
    // @duya/plugin-core's "main": "src/index.ts", which Node.js
    // cannot load natively (ERR_UNKNOWN_FILE_EXTENSION).
    const devBundle = path.join(process.cwd(), 'packages', 'agent', 'bundle', 'agent-process-entry.js');
    if (fs.existsSync(devBundle)) {
      return devBundle;
    }

    const devDist = path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
    if (fs.existsSync(devDist)) {
      return devDist;
    }

    return devBundle;
  }

  private resolveBetterSqlite3Path(): string {
    const isPackaged = !!process.resourcesPath && !process.defaultApp;
    if (isPackaged) {
      return path.join(process.resourcesPath, 'better-sqlite3');
    }

    return path.join(process.cwd(), 'node_modules', 'better-sqlite3');
  }

  killAll(): void {
    workerLogger.info('Killing all workers', { count: this.workers.size });
    for (const [sessionId] of this.workers) {
      this.killWorker(sessionId);
    }
    // Draining workers hold in-flight background sub-agents; on shutdown they
    // must be killed too (their sub-agents die with them, as before).
    for (const [sessionId, entry] of this.drainingWorkers) {
      workerLogger.info('Killing draining worker on shutdown', { sessionId, pid: entry.child.pid });
      this.killWorkerImpl(sessionId, entry.child);
    }
    this.drainingWorkers.clear();
  }
}

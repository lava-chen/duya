import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import type { StopDisposition } from '@duya/agent-protocol';
import {
  createWorkerEnvironment,
  getWorkerMaxMemoryMB,
  getWorkerIdleTtlMs,
  isLowPowerEnv,
  selectIdleSessionIds,
} from './worker-limits.js';

export { createWorkerEnvironment };

/** Session state hooks required by worker supervision. */
export interface WorkerSessionLifecycle {
  getState(sessionId: string): string | undefined;
  transitionToStreaming(sessionId: string): void;
  transitionToCrashed(sessionId: string): void;
}

/** Host-provided structured logging boundary. */
export interface WorkerManagerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
}

/** Environment-specific process paths and policy injected by the Host. */
export interface WorkerManagerOptions {
  logger: WorkerManagerLogger;
  resolveWorkerPath(): string;
  resolveBetterSqlite3Path(): string;
  lowPower?: boolean;
}

/** How much of one worker's stderr has already been accounted for. */
interface WorkerStderrState {
  /** Occurrences seen per distinct line. */
  readonly seen: Map<string, number>;
  /** Lines actually handed to the logger, repeats included. */
  emitted: number;
  /** Lines dropped past the ceiling. */
  dropped: number;
  ceilingReported: boolean;
  /** Trailing text after the last newline; an incomplete line. */
  pending: string;
}

/**
 * An interrupt that was put to a live worker, and when it took effect.
 *
 * Returned instead of the `true` this function used to return, so the run layer
 * can await a stop it cannot otherwise observe. `null` covers the old `false`
 * and keeps every existing truthiness check working unchanged.
 *
 * `settled` ALWAYS resolves — see {@link WorkerManager.interruptWorker} for the
 * three ways and why none of them waits on a reaping process.
 */
export interface WorkerInterrupt {
  /** Whether the interrupt command actually reached the worker. */
  readonly accepted: boolean;
  /** How the stop ended. Resolves exactly once. */
  readonly settled: Promise<StopDisposition>;
}

export class WorkerManager {
  private workers = new Map<string, ChildProcess>();
  private readonly sessionLifecycle: WorkerSessionLifecycle;
  private readonly options: WorkerManagerOptions;
  private readonly logger: WorkerManagerLogger;
  private onWorkerCrash: ((sessionId: string) => void) | null = null;
  private onWorkerMessage: ((sessionId: string, msg: Record<string, unknown>, child: ChildProcess) => void) | null = null;
  // H6: Track intentionally killed workers so their exit is not misjudged as a crash
  private intentionalKills = new WeakSet<ChildProcess>();
  // Plan 426 Phase 2: idle recycling. lastActivityAt refreshes on every
  // inbound worker message and every outbound command; the reaper kills
  // settled workers whose last activity is older than the TTL.
  private lastActivity = new Map<string, number>();
  private keepAliveSessions = new Set<string>();
  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lowPower: boolean;
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
  /**
   * Repeats of one stderr line that survive before the rest collapse into a
   * single summary, and the ceiling on lines emitted per worker.
   */
  private static readonly STDERR_REPEAT_SUMMARY_AT = 5;
  private static readonly STDERR_LINE_CEILING = 200;
  /** Per-worker stderr accounting. Weak so a dead worker frees its map. */
  private stderrStateByWorker = new WeakMap<ChildProcess, WorkerStderrState>();

  constructor(sessionLifecycle: WorkerSessionLifecycle, options: WorkerManagerOptions) {
    this.sessionLifecycle = sessionLifecycle;
    this.options = options;
    this.logger = options.logger;
    this.lowPower = options.lowPower ?? isLowPowerEnv();
  }

  setCrashHandler(handler: (sessionId: string) => void): void {
    this.onWorkerCrash = handler;
  }

  setMessageHandler(handler: (sessionId: string, msg: Record<string, unknown>, child: ChildProcess) => void): void {
    this.onWorkerMessage = handler;
  }

  /**
   * Account for one chunk of a worker's stderr.
   *
   * A worker's stderr is not only the worker's own logging: every child it
   * spawns (npm, MCP servers) inherits the pipe. One `npm install` against a
   * registry that 404s emits a wall of near-identical lines, and the previous
   * handler wrote each chunk TWICE — once as an ERROR "raw passthrough", once
   * classified — so every bit of child-process noise was both duplicated and
   * promoted to ERROR before it ever reached the log.
   *
   * Chunks do NOT align to lines: a pipe read can end mid-line, and one chunk
   * can carry many. So the text is buffered across chunks and only complete
   * lines are recorded — otherwise the repeat counter compares fragments that
   * differ only in where the kernel happened to split the write, and fifty
   * identical lines all count as distinct.
   */
  private recordWorkerStderr(
    sessionId: string,
    workerPid: number | undefined,
    child: ChildProcess,
    raw: string,
  ): void {
    const state = this.stderrStateFor(child);
    const parts = (state.pending + raw).split(/\r?\n/u);
    // The last element has no terminator yet — it is the start of the next line.
    state.pending = parts.pop() ?? '';
    for (const line of parts) {
      this.recordWorkerStderrLine(sessionId, workerPid, child, state, line.trim());
    }
  }

  /**
   * Flush the last line of a worker whose stderr ended without a newline.
   *
   * `close` (not `exit`) is the correct signal: Node fires it once the stdio
   * streams have closed, so nothing is still in flight when this runs.
   */
  private flushWorkerStderr(
    sessionId: string,
    workerPid: number | undefined,
    child: ChildProcess,
  ): void {
    const state = this.stderrStateByWorker.get(child);
    if (state === undefined) return;
    const tail = state.pending.trim();
    state.pending = '';
    if (tail !== '') this.recordWorkerStderrLine(sessionId, workerPid, child, state, tail);
  }

  private stderrStateFor(child: ChildProcess): WorkerStderrState {
    const existing = this.stderrStateByWorker.get(child);
    if (existing !== undefined) return existing;
    const created: WorkerStderrState = {
      seen: new Map(),
      emitted: 0,
      dropped: 0,
      ceilingReported: false,
      pending: '',
    };
    this.stderrStateByWorker.set(child, created);
    return created;
  }

  private recordWorkerStderrLine(
    sessionId: string,
    workerPid: number | undefined,
    child: ChildProcess,
    state: WorkerStderrState,
    line: string,
  ): void {
    if (line === '') return;

    if (state.emitted >= WorkerManager.STDERR_LINE_CEILING) {
      state.dropped += 1;
      if (state.ceilingReported) return;
      state.ceilingReported = true;
      this.logger.warn('Worker stderr line ceiling reached; further lines dropped', {
        sessionId,
        pid: workerPid,
        ceiling: WorkerManager.STDERR_LINE_CEILING,
      });
      return;
    }

    const occurrences = (state.seen.get(line) ?? 0) + 1;
    state.seen.set(line, occurrences);

    if (occurrences === WorkerManager.STDERR_REPEAT_SUMMARY_AT) {
      this.logger.warn('Worker stderr line repeating; further copies dropped', {
        sessionId,
        pid: workerPid,
        line,
        occurrences,
      });
    }
    if (occurrences > WorkerManager.STDERR_REPEAT_SUMMARY_AT) return;

    state.emitted += 1;
    const fields = { sessionId, pid: workerPid, line };

    if (line.startsWith('[ERROR]') || line.includes('Error:')) {
      this.logger.error('Worker stderr', new Error(line), fields);
    } else if (line.startsWith('[WARN]') || line.startsWith('[WARNING]')) {
      this.logger.warn('Worker stderr', fields);
    } else {
      // Covers [INFO], [DEBUG], and anything unrecognised. Unrecognised lines
      // stay INFO on purpose: a child process must not be able to manufacture
      // ERROR alerts that an operator then has to triage.
      this.logger.info('Worker stderr', fields);
    }
  }

  spawnWorker(sessionId: string): ChildProcess {
    // Create new worker BEFORE killing old one, so workers map stays populated during transition
    const oldChild = this.workers.get(sessionId);
    const workerPath = this.options.resolveWorkerPath();

    if (!fs.existsSync(workerPath)) {
      throw new Error(`Worker entry not found: ${workerPath}`);
    }

    const maxMemoryMB = getWorkerMaxMemoryMB();

    const env = createWorkerEnvironment(
      sessionId,
      maxMemoryMB,
      this.options.resolveBetterSqlite3Path(),
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
    this.logger.info('Worker spawned', {
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
      this.sessionLifecycle.transitionToStreaming(sessionId);
    } catch (err) {
      this.logger.warn('transitionState(STREAMING) skipped', {
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
        this.logger.info('Worker exit ignored (stale, already replaced)', { sessionId, pid: workerPid });
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
        this.logger.info('Worker exited normally', { sessionId, pid: workerPid });
      } else if (exitedBySignal || isIntentionalKill) {
        this.logger.info('Worker terminated by signal', { sessionId, pid: workerPid, signal, intentional: isIntentionalKill });
      } else {
        this.logger.warn('Worker exited with error code', { sessionId, pid: workerPid, exitCode: code, signal });
      }

      const sessionState = this.sessionLifecycle.getState(sessionId);
      if (sessionState !== undefined) {
        const isRealCrash = !isIntentionalKill && typeof code === 'number' && code > 0 && sessionState !== 'COMPLETED';
        if (isRealCrash) {
          try {
            this.sessionLifecycle.transitionToCrashed(sessionId);
          } catch {
            // State transition may be invalid if session already moved on
          }
          this.logger.error('Worker crash detected', undefined, { sessionId, exitCode: code, signal });
          if (this.onWorkerCrash) {
            this.onWorkerCrash(sessionId);
          }
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      this.recordWorkerStderr(sessionId, workerPid, child, data.toString());
    });

    child.on('close', () => {
      this.flushWorkerStderr(sessionId, workerPid, child);
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
      if (this.workers.get(sessionId) !== child && msg.type === 'db:request') {
        const action = typeof msg.action === 'string' ? msg.action : '';
        if (action.startsWith('session:spawn') || action === 'message:append') {
          child.send({
            type: 'db:response',
            id: msg.id,
            success: false,
            code: 'superseded_worker',
            error: action === 'message:append'
              ? 'Transcript append from a superseded worker is refused.'
              : 'Session delegation from a superseded worker is refused.',
          });
          return;
        }
      }
      // conductor:executor:rpc, appConnection:invoke,
      // appConnection:listDescriptors, appConnection:catalog,
      // computer-use:execute, and computer-use:cua are
      // handled by per-request handlers in the Desktop router (they forward
      // to main process) — this Host manager does not own those transports,
      // so they are dropped here. `db:request` is NOT dropped: when the HOST
      // owns execution (plan 12), the HostRunExecutionController serves it
      // from Host-owned stores via the centralized handler below.
      if (msg.type === 'conductor:executor:rpc' || msg.type === 'appConnection:invoke' || msg.type === 'appConnection:listDescriptors' || msg.type === 'appConnection:catalog' || msg.type === 'computer-use:execute' || msg.type === 'computer-use:cua') {
        return;
      }
      if (this.onWorkerMessage) {
        this.onWorkerMessage(sessionId, msg, child);
      }
    });

    child.on('error', (err) => {
      this.logger.error('Worker process error', err, { sessionId, pid: workerPid });
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
    this.logger.info('Worker replacement deferred (background sub-agents in flight)', {
      sessionId,
      pid: child.pid,
    });
    // Hard deadline: never leak a stuck draining worker forever.
    const timer = setTimeout(() => {
      if (this.drainingWorkers.get(sessionId)?.child !== child) return;
      this.drainingWorkers.delete(sessionId);
      this.logger.warn('Draining worker deadline exceeded, force killing', { sessionId, pid: child.pid });
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
    this.logger.info('Killing drained replacement worker', { sessionId, pid: entry.child.pid });
    this.killWorkerImpl(sessionId, entry.child);
  }

  /**
   * Ask a worker to stop, and get a bounded, reportable answer.
   *
   * The escalation below is NOT new in R2.3 — the grace timer and the kill have
   * always been here. What changed is that the result is now reachable: the
   * grace timer used to fire into a `setTimeout` whose only witness was a log
   * line, so the run layer could not tell a worker that left cleanly from one
   * that had to be killed, and recorded both as a clean cancellation.
   *
   * `null` when there is no worker, which keeps the historical boolean's
   * truthiness at every existing call site (`if (interruptWorker(...))`) while
   * giving the run layer a promise it can bound.
   *
   * `settled` resolves in exactly one of three ways, and always resolves:
   *
   *  - the child exits inside the grace window: `cooperative`.
   *  - the grace window expires and the kill is issued: `escalated`. It resolves
   *    when the kill is SENT, not when the process is reaped — waiting for a
   *    process that may never reap is how this call becomes the unbounded await
   *    the runtime also has to defend against.
   *  - the interrupt command could not be delivered: `unavailable`.
   */
  interruptWorker(sessionId: string, graceMs = 2000, reason = 'unknown'): WorkerInterrupt | null {
    const child = this.workers.get(sessionId);
    if (!child) return null;

    let settle: (disposition: StopDisposition) => void = () => undefined;
    const settled = new Promise<StopDisposition>((resolve) => {
      settle = resolve;
    });

    const sent = this.sendCommand(sessionId, { type: 'chat:interrupt', sessionId });
    // WARN (not INFO): the default log level is WARN, and the two callers that
    // matter for wakeless debugging (SSE client disconnect vs DELETE/collapse)
    // both route through here. `reason` tells us which one fired.
    this.logger.warn('Worker interrupt requested', {
      sessionId,
      pid: child.pid,
      sent,
      graceMs,
      reason,
    });

    // ONE timer, cleared on every exit below. A grace timer that survives the
    // child it was watching will kill a REPLACEMENT worker spawned into the same
    // session id, which is a far worse failure than the one it was meant to
    // prevent — so the `get(sessionId) === child` guard is load-bearing and is
    // not simplified away.
    const timeout = setTimeout(() => {
      if (this.workers.get(sessionId) !== child) {
        // The child was replaced or already gone; nothing of ours is running.
        settle('cooperative');
        return;
      }
      this.logger.warn('Worker still present after interrupt grace period, terminating', {
        sessionId,
        pid: child.pid,
      });
      this.killWorkerImpl(sessionId, child);
      settle('escalated');
    }, graceMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    child.once('exit', () => {
      clearTimeout(timeout);
      // The process left, but the timer may have fired first. `settle` is
      // idempotent on a settled promise, so a race between the two paths
      // resolves once, with the escalation winning if it got there first.
      settle('cooperative');
    });

    if (!sent) settle('unavailable');
    return { accepted: sent, settled };
  }

  // Internal kill that accepts the child directly, used by spawnWorker during replace
  private killWorkerImpl(sessionId: string, child: ChildProcess): void {
    this.logger.info('Killing worker', { sessionId, pid: child.pid });
    // H6: Mark this child as intentionally killed so the spawnWorker exit handler
    // does not misjudge it as a crash (especially on Windows).
    this.intentionalKills.add(child);
    let exited = false;
    const forceKillTimeout = setTimeout(() => {
      if (!exited) {
        this.logger.warn('Worker did not exit after termination signal, force killing', {
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
        this.lastActivity.delete(sessionId);
        this.logger.info('Worker terminated', { sessionId });
      }
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
      this.logger.warn('Worker not available for command', { sessionId, commandType: cmd.type, hasWorker: !!child, killed: child?.killed, hasStdin: !!child?.stdin });
      return false;
    }

    this.logger.debug('Sending command to worker', { sessionId, commandType: cmd.type });
    this.lastActivity.set(sessionId, Date.now());
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (err) {
      // C2: stdin.write can throw if the pipe is closed (worker exiting)
      this.logger.warn('Failed to write command to worker stdin', {
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
    this.logger.info('Broadcast command to workers', { commandType: cmd.type, workerCount: count });
    return count;
  }

  /**
   * ZCode-parity workflow anchor fallback: the most recently active live
   * worker session id. Panel-triggered workflow runs (POST
   * /workflow/:name/trigger) may arrive without a sessionId — the run card
   * needs SOME live worker to execute in, so the router falls back to the
   * session the user touched last. null when no worker is alive.
   */
  mostRecentWorkerSessionId(): string | null {
    let best: string | null = null;
    let bestAt = -1;
    for (const [sessionId, at] of this.lastActivity) {
      if (at > bestAt && this.workers.has(sessionId)) {
        best = sessionId;
        bestAt = at;
      }
    }
    return best;
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
      state: this.sessionLifecycle.getState(sessionId),
    }));
    for (const sessionId of selectIdleSessionIds(candidates, now, ttlMs)) {
      const child = this.workers.get(sessionId);
      if (!child) continue;
      // A kill is already in flight (killWorkerImpl marked it) — wait for
      // the exit event instead of stacking duplicate kill attempts.
      if (this.intentionalKills.has(child)) continue;
      const idleMs = now - (this.lastActivity.get(sessionId) ?? now);
      this.logger.info('Reaping idle worker', { sessionId, pid: child.pid, idleMs, ttlMs, lowPower: this.lowPower });
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

  /**
   * Absolute path of the agent process bundle. Public because the run-anchored
   * workflow runtime (plan 560 D2) spawns the SAME bundle under a different
   * `DUYA_AGENT_ROLE` rather than duplicating the packaged/dev resolution
   * rules here.
   */
  resolveWorkerPath(): string {
    return this.options.resolveWorkerPath();
  }

  /** Public for the same reason as `resolveWorkerPath` (plan 560 D2). */
  resolveBetterSqlite3Path(): string {
    return this.options.resolveBetterSqlite3Path();
  }

  killAll(): void {
    this.logger.info('Killing all workers', { count: this.workers.size });
    for (const [sessionId] of this.workers) {
      this.killWorker(sessionId);
    }
    // Draining workers hold in-flight background sub-agents; on shutdown they
    // must be killed too (their sub-agents die with them, as before).
    for (const [sessionId, entry] of this.drainingWorkers) {
      this.logger.info('Killing draining worker on shutdown', { sessionId, pid: entry.child.pid });
      this.killWorkerImpl(sessionId, entry.child);
    }
    this.drainingWorkers.clear();
  }
}

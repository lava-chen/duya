/**
 * services/recorder/service.ts — recorder orchestration (plan 556 Phase 1).
 *
 * Owns one recording session at a time and wires the pipeline:
 *
 *   hook-worker ──WorkerEvent──▶ filters ──▶ Aggregator ──▶ probe enrich
 *   focus-tracker ──app focus──▶ (self/blk)              ──▶ SessionStore
 *
 * Filters (design §4.9): events are dropped when the foreground app is
 * duya itself (input into our own windows, badge included) or when the
 * process matches the `recorder.blockedApps` defaults (password
 * managers).
 *
 * State machine: idle → starting → recording ⇄ stopping → idle, with a
 * `degraded` flag when the hook worker exhausted its single restart
 * (recording continues without input events, UI surfaces the state).
 * Start/stop are single-flight; a 10-minute cap auto-stops the session.
 *
 * Logging discipline (AGENTS.md red line): never log captured text —
 * only counts and state transitions.
 */

import { randomUUID } from 'node:crypto';

import {
  RecorderAggregator,
  SessionStore,
  getDefaultRecorderRootDir,
  shouldDropEventForApp,
  type AppRef,
  type ElementDescriptor,
  type FeedContext,
  type RecorderEvent,
  type SessionSummary,
  type WorkerEvent,
} from '@duya/computer-use';
import { getLogger, LogComponent } from '../../logging/logger.js';
import { RecorderHookWorker } from './hook-worker.js';
import { RecorderFocusTracker } from './focus-tracker.js';

const logger = getLogger();

/** Default recording cap (design §2, teach-recording parity). */
export const DEFAULT_MAX_DURATION_MS = 10 * 60_000;

/** Aggregator poll cadence for silence flushes. */
const POLL_INTERVAL_MS = 1_000;

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping';

export interface RecorderStatusSnapshot {
  status: RecorderStatus;
  sessionId: string | null;
  startedAt: number | null;
  durationMs: number | null;
  eventCount: number;
  /** True when the hook worker died through its restart budget. */
  degraded: boolean;
}

export type RecorderProbe = (x: number, y: number) => Promise<ElementDescriptor>;

type HookWorkerCallbacks = ConstructorParameters<typeof RecorderHookWorker>[0];

/** Minimal worker surface the service relies on (keeps tests simple). */
type WorkerLike = Pick<RecorderHookWorker, 'start' | 'stop'>;

export interface RecorderServiceOptions {
  rootDir?: string;
  maxDurationMs?: number;
  /** UIA element probe (Phase 2 wires this; Phase 1 runs without). */
  probe?: RecorderProbe;
  /** Test hook: replace hook worker construction. */
  createWorker?: (callbacks: HookWorkerCallbacks) => WorkerLike;
}

interface FocusInfo {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
}

function toAppRef(info: FocusInfo): AppRef {
  return {
    name: info.processName,
    title: info.title,
    processName: info.processName,
    pid: info.pid,
  };
}

export class RecorderService {
  private status: RecorderStatus = 'idle';
  private degraded = false;
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private lastSummary: SessionSummary | null = null;

  private store: SessionStore | null = null;
  private aggregator: RecorderAggregator | null = null;
  private worker: WorkerLike | null = null;
  private tracker: RecorderFocusTracker | null = null;

  private currentApp: AppRef | null = null;
  private redactHint = false;
  private droppedNoApp = 0;
  private droppedFiltered = 0;
  private appendErrors = 0;
  private appendChain: Promise<void> = Promise.resolve();

  private pollTimer: NodeJS.Timeout | null = null;
  private maxDurationTimer: NodeJS.Timeout | null = null;

  private startInFlight: Promise<void> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private disposed = false;

  private statusListeners = new Set<(snapshot: RecorderStatusSnapshot) => void>();

  private readonly opts: {
    rootDir: string;
    maxDurationMs: number;
    probe?: RecorderProbe;
    createWorker?: RecorderServiceOptions['createWorker'];
  };

  constructor(opts: RecorderServiceOptions = {}) {
    this.opts = {
      rootDir: opts.rootDir ?? getDefaultRecorderRootDir(),
      maxDurationMs: opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      probe: opts.probe,
      createWorker: opts.createWorker,
    };
  }

  // --- lifecycle --------------------------------------------------------

  async start(): Promise<RecorderStatusSnapshot> {
    if (this.disposed) {
      throw new Error('RecorderService has been disposed');
    }
    if (this.status === 'recording' || this.status === 'starting') {
      return this.getSnapshot();
    }
    if (this.stopInFlight) {
      await this.stopInFlight;
    }
    if (this.startInFlight) {
      await this.startInFlight;
      return this.getSnapshot();
    }
    this.startInFlight = this.doStart();
    try {
      await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
    return this.getSnapshot();
  }

  async stop(): Promise<SessionSummary | null> {
    if (this.status !== 'recording' && this.status !== 'starting') {
      return null;
    }
    if (this.stopInFlight) {
      await this.stopInFlight;
      return this.lastSummary;
    }
    this.stopInFlight = this.doStop();
    try {
      await this.stopInFlight;
    } finally {
      this.stopInFlight = null;
    }
    return this.lastSummary;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.status === 'recording' || this.status === 'starting') {
      await this.stop();
    }
    this.statusListeners.clear();
  }

  private async doStart(): Promise<void> {
    this.setStatus('starting');
    this.degraded = false;
    this.droppedNoApp = 0;
    this.droppedFiltered = 0;
    this.appendErrors = 0;
    this.currentApp = null;
    this.redactHint = false;

    const sessionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const store = new SessionStore(this.opts.rootDir, sessionId);
    await store.start();

    this.sessionId = sessionId;
    this.startedAt = Date.now();
    this.store = store;
    this.aggregator = new RecorderAggregator();

    // Focus tracker first: the immediate query gives the aggregator an
    // app snapshot before the first keystroke arrives.
    this.tracker = new RecorderFocusTracker({
      onChange: (prev, next) => this.handleFocusChange(prev, next),
    });
    this.tracker.start();

    const workerCallbacks: HookWorkerCallbacks = {
      onEvent: (event) => this.handleWorkerEvent(event),
      onCrash: () => {
        // First failure consumed the single restart budget; from here
        // the recording is degraded but still running.
        this.degraded = true;
        this.emitStatus();
      },
      onFailed: (reason) => this.handleWorkerFailed(reason),
    };
    this.worker = this.opts.createWorker
      ? this.opts.createWorker(workerCallbacks)
      : new RecorderHookWorker(workerCallbacks);
    await this.worker.start();

    this.pollTimer = setInterval(() => this.pollAggregator(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.maxDurationTimer = setTimeout(() => {
      logger.info('recorder max duration reached; auto-stopping', undefined, LogComponent.ComputerUse);
      void this.stop();
    }, this.opts.maxDurationMs);
    this.maxDurationTimer.unref?.();

    this.setStatus('recording');
    logger.info('recorder session started', undefined, LogComponent.ComputerUse);
  }

  private async doStop(): Promise<void> {
    this.setStatus('stopping');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.tracker) {
      await this.tracker.stop();
      this.tracker = null;
    }
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      await worker.stop();
    }
    // Final flush of whatever the aggregator still buffers.
    const aggregator = this.aggregator;
    if (aggregator) {
      const flush = aggregator.finish(this.feedContext());
      for (const event of flush) {
        this.enqueueAppend(event);
      }
    }
    await this.appendChain;
    const store = this.store;
    if (store) {
      try {
        this.lastSummary = await store.end();
      } catch (err) {
        logger.error(
          'recorder session summary write failed',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          LogComponent.ComputerUse,
        );
      }
    }
    this.aggregator = null;
    this.store = null;
    this.sessionId = null;
    this.startedAt = null;
    this.currentApp = null;
    this.setStatus('idle');
    logger.info(
      'recorder session stopped',
      { degraded: this.degraded, droppedNoApp: this.droppedNoApp, droppedFiltered: this.droppedFiltered },
      LogComponent.ComputerUse,
    );
  }

  // --- wiring -----------------------------------------------------------

  private handleFocusChange(prev: FocusInfo | null, next: FocusInfo): void {
    const aggregator = this.aggregator;
    if (!aggregator) {
      return;
    }
    const prevApp = prev ? toAppRef(prev) : null;
    const nextApp = toAppRef(next);

    // Typing/wheel buffers belong to the app being LEFT.
    if (prevApp && !this.isSelfPid(prevApp.pid) && !shouldDropEventForApp(prevApp)) {
      for (const event of aggregator.onAppChanged(prevApp, this.feedContext())) {
        this.enqueueAppend(event);
      }
    }
    this.redactHint = false;
    this.currentApp = nextApp;

    // app_focus for duya's own windows is intentionally not recorded.
    if (this.isSelfPid(nextApp.pid) || shouldDropEventForApp(nextApp)) {
      return;
    }
    const focusEvent: RecorderEvent = {
      type: 'app_focus',
      ts: Date.now(),
      app: nextApp,
    };
    this.enqueueAppend(focusEvent);
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    const aggregator = this.aggregator;
    if (!aggregator || this.status !== 'recording') {
      return;
    }
    const app = this.currentApp;
    if (!app) {
      this.droppedNoApp += 1;
      return;
    }
    if (this.isSelfPid(app.pid) || shouldDropEventForApp(app)) {
      this.droppedFiltered += 1;
      return;
    }
    for (const out of aggregator.feed(event, this.feedContext())) {
      this.enqueueAppend(out);
    }
  }

  private handleWorkerFailed(reason: string): void {
    // Restart budget spent: recording continues without input events
    // (design §5 degraded mode); the UI surfaces the flag.
    this.degraded = true;
    logger.warn('recorder degraded: hook worker unavailable', { reason }, LogComponent.ComputerUse);
    this.emitStatus();
  }

  private pollAggregator(): void {
    const aggregator = this.aggregator;
    if (!aggregator || this.status !== 'recording') {
      return;
    }
    const app = this.currentApp;
    if (!app || this.isSelfPid(app.pid) || shouldDropEventForApp(app)) {
      return;
    }
    for (const out of aggregator.poll(this.feedContext())) {
      this.enqueueAppend(out);
    }
  }

  private feedContext(): FeedContext {
    return {
      app: this.currentApp ?? { name: '', title: '', processName: '', pid: 0 },
      redact: this.redactHint,
    };
  }

  /**
   * Serialized append: events reach the JSONL strictly in the order
   * they were produced, even while click enrichment awaits the probe.
   */
  private enqueueAppend(event: RecorderEvent): void {
    this.appendChain = this.appendChain
      .then(() => this.enrichAndAppend(event))
      .catch((err) => {
        this.appendErrors += 1;
        logger.error(
          'recorder event append failed',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          LogComponent.ComputerUse,
        );
      });
  }

  private async enrichAndAppend(event: RecorderEvent): Promise<void> {
    const store = this.store;
    if (!store) {
      return;
    }
    await store.append(await this.enrich(event));
  }

  /**
   * Attach the UIA element to click events (async attach within the
   * probe budget; Phase 2 provides the probe, Phase 1 runs without one).
   */
  private async enrich(event: RecorderEvent): Promise<RecorderEvent> {
    if (event.type !== 'click' || !this.opts.probe) {
      return event;
    }
    try {
      const element = await Promise.race([
        this.opts.probe(event.click.x, event.click.y),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), 200);
          t.unref?.();
        }),
      ]);
      if (element) {
        // A password field flips the redaction hint for the keystrokes
        // typed after the click into that field.
        if (element.isPassword === true) {
          this.redactHint = true;
        }
        return { ...event, element };
      }
    } catch {
      // probe failure degrades to source:'none' — never blocks recording
    }
    return event;
  }

  private isSelfPid(pid: number): boolean {
    return pid === process.pid;
  }

  // --- status -----------------------------------------------------------

  onStatus(listener: (snapshot: RecorderStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      // swallow listener errors
    }
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getSnapshot(): RecorderStatusSnapshot {
    const eventCount = this.store?.currentSummary.eventCount ?? this.lastSummary?.eventCount ?? 0;
    return {
      status: this.status,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      durationMs: this.startedAt !== null ? Date.now() - this.startedAt : null,
      eventCount,
      degraded: this.degraded,
    };
  }

  private setStatus(status: RecorderStatus): void {
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // swallow listener errors
      }
    }
  }
}

// --- module singleton (IPC wiring in Phase 5) -----------------------------

let _singleton: RecorderService | null = null;

export function getRecorderService(): RecorderService {
  if (!_singleton) {
    _singleton = new RecorderService();
  }
  return _singleton;
}

/** Test-only: reset the singleton. */
export function __resetRecorderService(): void {
  _singleton = null;
}

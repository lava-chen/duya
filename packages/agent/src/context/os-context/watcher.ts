/**
 * watcher.ts — chokidar-backed file watcher for the OSContextBridge.
 *
 * Watches `~/.duya/context/*.json` (one file per active wake-agent
 * session). Each file is a full `ContextPayload` written by the
 * computer-use-demo daemon. When a file changes, we parse + prune +
 * emit the resulting `OSContext` to listeners.
 *
 * Debouncing:
 *   - chokidar already coalesces per-file fs events, but we add a
 *     200ms trailing debounce per-path to absorb the daemon's quick
 *     bursts (screen captures happen at ~2 Hz on v0.2, ~0.5 Hz on v0.3).
 *
 * Robustness:
 *   - `ignoreInitial: false` so we surface the daemon's first write
 *     even if the listener subscribed after the file appeared.
 *   - `awaitWriteFinish: true` ensures we don't parse a half-written
 *     file (which would JSON.parse-error and drop, leaving the
 *     listener stuck on stale data).
 *
 * Plan 453 Task B.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';

import { logger } from '../../utils/logger.js';
import { parseOSContext, type ParseOutcome } from './payload.js';
import type { OSContext } from './types.js';

/** Component tag for structured logs. */
const COMPONENT = 'OSContextBridge';

/** Debounce window — 200ms absorbs daemon's short bursts. */
const DEBOUNCE_MS = 200;

/**
 * The directory the daemon writes to. Override via
 * `OSContextBridge.start({ contextDir })` for tests.
 */
export const DEFAULT_CONTEXT_DIR = path.join(homedir(), '.duya', 'context');

export interface ContextWatcherOptions {
  /** Override the watched directory. Defaults to `~/.duya/context/`. */
  contextDir?: string;
  /** Override the per-file debounce window. Defaults to 200ms. */
  debounceMs?: number;
  /**
   * Override chokidar's `awaitWriteFinish` stability threshold (ms).
   * Defaults to 2000ms. Tests use a smaller value to avoid 2s waits.
   */
  awaitWriteFinishStabilityMs?: number;
  /**
   * Inject a parse function (tests use this to bypass
   * `parseOSContext`).
   */
  parse?: (raw: string) => ParseOutcome;
}

/**
 * Per-file debounce state. We track the trailing timer so we can
 * flush on stop().
 */
interface FileDebounceState {
  timer: NodeJS.Timeout | null;
  pending: string | null;
}

export type WatcherEvent =
  | { kind: 'context'; path: string; context: OSContext }
  | { kind: 'parse-error'; path: string; reason: string }
  | { kind: 'watcher-error'; error: Error };

/**
 * File watcher over `~/.duya/context/*.json`. Emits parsed `OSContext`
 * events to subscribers. NOT a singleton — the bridge owns one and
 * shares it across consumers.
 */
export class ContextWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly contextDir: string;
  private readonly debounceMs: number;
  private readonly awaitWriteFinishStabilityMs: number;
  private readonly parse: (raw: string) => ParseOutcome;
  private readonly debounceState = new Map<string, FileDebounceState>();

  constructor(opts: ContextWatcherOptions = {}) {
    super();
    this.contextDir = opts.contextDir ?? DEFAULT_CONTEXT_DIR;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.awaitWriteFinishStabilityMs =
      opts.awaitWriteFinishStabilityMs ?? 2000;
    this.parse = opts.parse ?? parseOSContext;
  }

  /** Start watching. Idempotent — calling twice is a no-op. */
  async start(): Promise<void> {
    if (this.watcher) return;
    logger.info(
      'ContextWatcher starting',
      { contextDir: this.contextDir, debounceMs: this.debounceMs },
      COMPONENT,
    );
    this.watcher = chokidar.watch(path.join(this.contextDir, '*.json'), {
      awaitWriteFinish: {
        stabilityThreshold: this.awaitWriteFinishStabilityMs,
        pollInterval: 50,
      },
      ignoreInitial: false,
      persistent: true,
      usePolling: false,
    });
    this.watcher.on('add', (p) => void this.handleFileChange(p));
    this.watcher.on('change', (p) => void this.handleFileChange(p));
    this.watcher.on('unlink', (p) => this.handleFileUnlink(p));
    this.watcher.on('error', (err) => {
      logger.error(
        'ContextWatcher error',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        COMPONENT,
      );
      this.emit('event', {
        kind: 'watcher-error',
        error: err instanceof Error ? err : new Error(String(err)),
      } satisfies WatcherEvent);
    });
  }

  /** Stop watching and clear pending debounce timers. */
  async stop(): Promise<void> {
    if (!this.watcher) return;
    logger.info('ContextWatcher stopping', undefined, COMPONENT);
    for (const state of this.debounceState.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.debounceState.clear();
    await this.watcher.close();
    this.watcher = null;
  }

  /** Flush all pending debounce timers immediately. */
  flushPending(): void {
    for (const [p, state] of this.debounceState.entries()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.pending !== null) {
        this.dispatch(p, state.pending);
      }
    }
    this.debounceState.clear();
  }

  private async handleFileChange(p: string): Promise<void> {
    let state = this.debounceState.get(p);
    if (!state) {
      state = { timer: null, pending: null };
      this.debounceState.set(p, state);
    }
    state.pending = p;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.dispatch(p, p);
      this.debounceState.delete(p);
    }, this.debounceMs);
  }

  private handleFileUnlink(p: string): void {
    // Cancel pending debounce — file is gone.
    const state = this.debounceState.get(p);
    if (state?.timer) clearTimeout(state.timer);
    this.debounceState.delete(p);
    // We intentionally do NOT emit a "context-gone" event. Consumers
    // should treat stale `current` as fallback; the bridge will
    // surface the next valid payload once the daemon rewrites.
  }

  private dispatch(p: string, _target: string): void {
    void this.readAndEmit(p);
  }

  private async readAndEmit(p: string): Promise<void> {
    let raw: string;
    try {
      const fs = await import('node:fs/promises');
      raw = await fs.readFile(p, 'utf-8');
    } catch (err) {
      logger.warn(
        'ContextWatcher: read failed',
        { path: p, error: err instanceof Error ? err.message : String(err) },
        COMPONENT,
      );
      this.emit('event', {
        kind: 'parse-error',
        path: p,
        reason: 'read-failed',
      } satisfies WatcherEvent);
      return;
    }

    const outcome = this.parse(raw);
    if (outcome.ok) {
      this.emit('event', {
        kind: 'context',
        path: p,
        context: outcome.context,
      } satisfies WatcherEvent);
    } else {
      logger.warn(
        'ContextWatcher: parse rejected',
        { path: p, reason: outcome.reason, detail: outcome.detail },
        COMPONENT,
      );
      this.emit('event', {
        kind: 'parse-error',
        path: p,
        reason: outcome.reason,
      } satisfies WatcherEvent);
    }
  }
}
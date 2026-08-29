/**
 * bridge.ts — OSContextBridge singleton.
 *
 * Owns the `ContextWatcher` and exposes a coarse enable/disable gate.
 *
 * Lifecycle:
 *   - `start()` is idempotent and creates the watcher.
 *   - `enable()` turns on dispatch to listeners. The watcher keeps
 *     running so we don't lose ticks; we just don't fan them out.
 *     This keeps a session warm — when the user toggles Wake on,
 *     `getCurrent()` immediately has the latest snapshot.
 *   - `disable()` suppresses new emits. Existing listeners stay
 *     subscribed.
 *   - `subscribe()` adds a listener and returns an unsubscribe
 *     function (EventEmitter convention).
 *
 * Threading / concurrency:
 *   - Node single-threaded event loop. enable/disable transitions are
 *     immediate. No locking needed.
 *
 * Plan 453 Task B.
 */

import { logger } from '../../utils/logger.js';
import { ContextWatcher, type WatcherEvent } from './watcher.js';
import type { OSContext } from './types.js';

/** Component tag for structured logs. */
const COMPONENT = 'OSContextBridge';

export type OSContextListener = (ctx: OSContext) => void;
export type OSContextErrorListener = (reason: string, path: string) => void;

export interface OSContextBridge {
  /**
   * Start the underlying file watcher. Idempotent.
   * Safe to call before any subscriber exists — the watcher still
   * accumulates the latest payload so `getCurrent()` is correct as
   * soon as the daemon writes.
   */
  start(): Promise<void>;

  /** Stop watching and clear all state. Idempotent. */
  stop(): Promise<void>;

  /**
   * Enable fan-out to listeners. Default state on startup is
   * `disabled` (privacy by default — the daemon keeps running but
   * the bridge stays quiet until the user opens the Orb).
   */
  enable(): void;

  /** Stop dispatching to listeners (subscribers stay attached). */
  disable(): void;

  /** Whether fan-out is currently on. */
  isEnabled(): boolean;

  /**
   * Latest parsed context. Updated continuously regardless of
   * `enable()` so toggling the Orb on surfaces the latest snapshot
   * without waiting for the next daemon write.
   */
  getCurrent(): OSContext | null;

  /**
   * Subscribe to context updates. Listener fires only when the bridge
   * is `enabled` AND the watcher dispatches a parse-ok event.
   * Returns an unsubscribe function.
   */
  subscribe(listener: OSContextListener): () => void;

  /**
   * Subscribe to parse failures (corrupt JSON, unknown schema, etc).
   * Fires regardless of enable state — useful for surfacing "Context
   * Source Offline" UI when the daemon produces bad output.
   */
  subscribeErrors(listener: OSContextErrorListener): () => void;

  /**
   * Test-only: replace the bridge with one backed by a custom
   * watcher (lets unit tests inject fixtures without touching the
   * real `~/.duya/context/` directory).
   */
  __setBridgeForTest(replacement: OSContextBridge | null): void;
}

class OSContextBridgeImpl implements OSContextBridge {
  private watcher: ContextWatcher | null = null;
  private enabled = false;
  private current: OSContext | null = null;
  private readonly listeners = new Set<OSContextListener>();
  private readonly errorListeners = new Set<OSContextErrorListener>();

  async start(): Promise<void> {
    if (this.watcher) return;
    this.watcher = new ContextWatcher();
    this.watcher.on('event', (event: WatcherEvent) => this.handleWatcherEvent(event));
    await this.watcher.start();
    logger.info('OSContextBridge started', undefined, COMPONENT);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.stop();
    this.watcher = null;
    this.current = null;
    this.listeners.clear();
    this.errorListeners.clear();
    this.enabled = false;
    logger.info('OSContextBridge stopped', undefined, COMPONENT);
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    logger.info('OSContextBridge enabled', undefined, COMPONENT);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    logger.info('OSContextBridge disabled', undefined, COMPONENT);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getCurrent(): OSContext | null {
    return this.current;
  }

  subscribe(listener: OSContextListener): () => void {
    this.listeners.add(listener);
    // Fire immediately with the current snapshot if we have one AND
    // the bridge is enabled. This is what makes "open Orb → see what
    // the user is looking at" feel instant.
    if (this.enabled && this.current) {
      try {
        listener(this.current);
      } catch (err) {
        logger.error(
          'OSContextBridge listener threw on initial fire',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          COMPONENT,
        );
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeErrors(listener: OSContextErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  __setBridgeForTest(replacement: OSContextBridge | null): void {
    // Only honored when NODE_ENV === 'test' or DUYA_TEST=1 to avoid
    // prod misuse.
    if (
      process.env.NODE_ENV !== 'test' &&
      process.env.DUYA_TEST !== '1' &&
      process.env.VITEST !== 'true'
    ) {
      logger.warn(
        '__setBridgeForTest called outside test env, ignoring',
        undefined,
        COMPONENT,
      );
      return;
    }
    _singleton = replacement;
  }

  private handleWatcherEvent(event: WatcherEvent): void {
    if (event.kind === 'context') {
      this.current = event.context;
      if (this.enabled) {
        for (const listener of this.listeners) {
          try {
            listener(event.context);
          } catch (err) {
            logger.error(
              'OSContextBridge listener threw',
              err instanceof Error ? err : new Error(String(err)),
              undefined,
              COMPONENT,
            );
          }
        }
      }
    } else if (event.kind === 'parse-error') {
      logger.warn(
        'OSContextBridge parse-error',
        { reason: event.reason, path: event.path },
        COMPONENT,
      );
      for (const listener of this.errorListeners) {
        try {
          listener(event.reason, event.path);
        } catch {
          // swallow listener errors — they shouldn't break the watcher
        }
      }
    } else {
      logger.error(
        'OSContextBridge watcher-error',
        event.error,
        undefined,
        COMPONENT,
      );
    }
  }
}

let _singleton: OSContextBridge | null = null;

/** Get the OSContextBridge singleton. Lazily created on first call. */
export function getOSContextBridge(): OSContextBridge {
  if (!_singleton) {
    _singleton = new OSContextBridgeImpl();
  }
  return _singleton;
}

/** Reset the singleton — only used by tests. */
export function __resetOSContextBridge(): void {
  _singleton = null;
}
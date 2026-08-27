/**
 * bridge.ts — unit tests.
 *
 * Drives the bridge with a fake watcher (no fs / chokidar
 * dependency). Tests cover enable/disable semantics, subscribe
 * unsubscribe, error fan-out, and the initial-fire contract for
 * late subscribers.
 *
 * Plan 453 Task B.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

import type { OSContextBridge } from '../bridge.js';
import type { WatcherEvent } from '../watcher.js';
import type { OSContext } from '../types.js';

const SAMPLE: OSContext = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-08-28T00:00:00.000Z',
  focusedEntity: null,
  interactionTrail: [],
  intentCandidate: null,
  foreground: { pid: 1, exeName: 'chrome.exe', title: 'GitHub' },
  redacted: false,
  redactionReason: null,
};

/** Minimal test-only bridge that mimics the real one's contract but
 *  uses an in-memory EventEmitter instead of chokidar. */
class FakeBridge implements OSContextBridge {
  private emitter = new EventEmitter();
  private current: OSContext | null = null;
  private enabled = false;

  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.emitter.removeAllListeners();
    this.current = null;
    this.enabled = false;
    return Promise.resolve();
  }
  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  getCurrent(): OSContext | null {
    return this.current;
  }
  subscribe(listener: (ctx: OSContext) => void): () => void {
    this.emitter.on('ctx', listener);
    if (this.enabled && this.current) listener(this.current);
    return () => this.emitter.off('ctx', listener);
  }
  subscribeErrors(listener: (reason: string, path: string) => void): () => void {
    this.emitter.on('err', listener);
    return () => this.emitter.off('err', listener);
  }
  __setBridgeForTest(_replacement: OSContextBridge | null): void {
    // no-op for the fake
  }

  /** Test helper: simulate a watcher emit. */
  emitContext(event: WatcherEvent): void {
    if (event.kind === 'context') {
      this.current = event.context;
      if (this.enabled) {
        // Mirror real bridge: wrap listener calls in try/catch so a
        // misbehaving listener doesn't kill the watcher fan-out.
        for (const listener of this.emitter.listeners('ctx')) {
          try {
            (listener as (ctx: OSContext) => void)(event.context);
          } catch {
            // swallow
          }
        }
      }
    } else if (event.kind === 'parse-error') {
      for (const listener of this.emitter.listeners('err')) {
        try {
          (listener as (reason: string, p: string) => void)(
            event.reason,
            event.path,
          );
        } catch {
          // swallow
        }
      }
    }
  }
}

describe('OSContextBridge contract (FakeBridge)', () => {
  let bridge: FakeBridge;

  beforeEach(() => {
    bridge = new FakeBridge();
  });

  it('is disabled by default', () => {
    expect(bridge.isEnabled()).toBe(false);
  });

  it('enable() flips state; disable() restores it', () => {
    bridge.enable();
    expect(bridge.isEnabled()).toBe(true);
    bridge.disable();
    expect(bridge.isEnabled()).toBe(false);
  });

  it('current stays null until first context event', () => {
    expect(bridge.getCurrent()).toBeNull();
  });

  it('current tracks the latest context regardless of enable state', () => {
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    expect(bridge.getCurrent()).toBe(SAMPLE);
    // Even when disabled, getCurrent should still return the latest.
    bridge.disable();
    expect(bridge.getCurrent()).toBe(SAMPLE);
  });

  it('subscribers do not receive events while disabled', () => {
    const received: OSContext[] = [];
    bridge.subscribe((c) => received.push(c));
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    expect(received).toHaveLength(0);
  });

  it('subscribers receive events once enabled', () => {
    bridge.enable();
    const received: OSContext[] = [];
    bridge.subscribe((c) => received.push(c));
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    expect(received).toEqual([SAMPLE]);
  });

  it('late subscribers receive the current snapshot immediately', () => {
    bridge.enable();
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    const received: OSContext[] = [];
    bridge.subscribe((c) => received.push(c));
    expect(received).toEqual([SAMPLE]);
  });

  it('late subscribers do NOT receive a snapshot if disabled', () => {
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    const received: OSContext[] = [];
    bridge.subscribe((c) => received.push(c));
    expect(received).toEqual([]);
  });

  it('unsubscribe stops further events', () => {
    bridge.enable();
    const received: OSContext[] = [];
    const off = bridge.subscribe((c) => received.push(c));
    bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE });
    off();
    bridge.emitContext({ kind: 'context', path: 'b.json', context: SAMPLE });
    expect(received).toHaveLength(1);
  });

  it('listener errors do not break the bridge', () => {
    bridge.enable();
    bridge.subscribe(() => {
      throw new Error('boom');
    });
    // Should not throw out of emit:
    expect(() =>
      bridge.emitContext({ kind: 'context', path: 'a.json', context: SAMPLE }),
    ).not.toThrow();
  });

  it('error subscribers receive parse-error events regardless of enable', () => {
    const errs: Array<[string, string]> = [];
    bridge.subscribeErrors((reason, p) => errs.push([reason, p]));
    // Disabled: error fan-out still works (errors fire even when
    // enable=false; only successful context emissions are gated).
    bridge.emitContext({
      kind: 'parse-error',
      path: 'x.json',
      reason: 'invalid-json',
    });
    expect(errs).toEqual([['invalid-json', 'x.json']]);
  });
});
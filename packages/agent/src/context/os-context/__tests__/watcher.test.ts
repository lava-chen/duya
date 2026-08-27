/**
 * watcher.ts — unit tests.
 *
 * Exercises chokidar with a per-test tmp dir to avoid touching the
 * real `~/.duya/context/`.
 *
 * Plan 453 Task B.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ContextWatcher } from '../watcher.js';
import type { WatcherEvent } from '../watcher.js';
import { parseOSContext } from '../payload.js';

function collectEvents(watcher: ContextWatcher): WatcherEvent[] {
  const out: WatcherEvent[] = [];
  watcher.on('event', (e: WatcherEvent) => out.push(e));
  return out;
}

function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const v = predicate();
      if (v !== undefined) {
        resolve(v);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const VALID_PAYLOAD = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-08-28T00:00:00.000Z',
  focus: {
    foregroundPid: 1,
    foregroundProcessName: 'chrome.exe',
    foregroundHwnd: '0xCAFE',
    focusControlClassName: 'Chrome_RenderWidgetHostHWND',
  },
  redaction: { redacted: false, reason: null },
  focusedEntity: null,
  intentCandidate: null,
  interactionTrail: [],
  platform: 'win32',
  assembleDurationMs: 42,
};

describe('ContextWatcher', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'osctx-watch-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits a context event when a file is added', async () => {
    const watcher = new ContextWatcher({
      contextDir: tmp,
      debounceMs: 10,
      awaitWriteFinishStabilityMs: 50,
      parse: (raw: string) => parseOSContext(raw),
    });
    const events = collectEvents(watcher);
    await watcher.start();

    const filePath = path.join(tmp, 'session-a.json');
    writeFileSync(filePath, JSON.stringify(VALID_PAYLOAD));

    const ev = await waitFor(() =>
      events.find((e) => e.kind === 'context'),
    );
    if (ev.kind !== 'context') throw new Error('not context');
    expect(ev.context.foreground.exeName).toBe('chrome.exe');

    await watcher.stop();
  });

  it('debounces rapid writes into one event', async () => {
    const watcher = new ContextWatcher({
      contextDir: tmp,
      debounceMs: 100,
      awaitWriteFinishStabilityMs: 50,
    });
    const events = collectEvents(watcher);
    await watcher.start();

    const filePath = path.join(tmp, 'session-b.json');
    writeFileSync(filePath, JSON.stringify(VALID_PAYLOAD));
    // Quick second write — chokidar should fire change, our debounce
    // collapses to one emit.
    setTimeout(() => {
      writeFileSync(
        filePath,
        JSON.stringify({ ...VALID_PAYLOAD, capturedAt: '2026-08-28T00:00:01.000Z' }),
      );
    }, 30);

    await new Promise((r) => setTimeout(r, 250));
    const contextEvents = events.filter((e) => e.kind === 'context');
    // Allow 1-2 (chokidar `add` + collapsed `change`), but should
    // NOT be 3+ since debounce absorbs bursts.
    expect(contextEvents.length).toBeLessThanOrEqual(2);
    expect(contextEvents.length).toBeGreaterThanOrEqual(1);

    await watcher.stop();
  });

  it('emits parse-error on corrupt JSON', async () => {
    const watcher = new ContextWatcher({
      contextDir: tmp,
      debounceMs: 10,
      awaitWriteFinishStabilityMs: 50,
    });
    const events = collectEvents(watcher);
    await watcher.start();

    writeFileSync(path.join(tmp, 'session-c.json'), '{not valid json');

    const ev = await waitFor(() =>
      events.find((e) => e.kind === 'parse-error'),
    );
    if (ev.kind !== 'parse-error') throw new Error('not parse-error');
    expect(ev.reason).toBe('invalid-json');

    await watcher.stop();
  });

  it('emits parse-error on unsupported schemaVersion', async () => {
    const watcher = new ContextWatcher({
      contextDir: tmp,
      debounceMs: 10,
      awaitWriteFinishStabilityMs: 50,
    });
    const events = collectEvents(watcher);
    await watcher.start();

    writeFileSync(
      path.join(tmp, 'session-d.json'),
      JSON.stringify({ ...VALID_PAYLOAD, schemaVersion: '99.0.0' }),
    );

    const ev = await waitFor(() =>
      events.find((e) => e.kind === 'parse-error'),
    );
    if (ev.kind !== 'parse-error') throw new Error('not parse-error');
    expect(ev.reason).toBe('unsupported-schema-version');

    await watcher.stop();
  });

  it('start() is idempotent', async () => {
    const watcher = new ContextWatcher({ contextDir: tmp });
    await watcher.start();
    await watcher.start(); // should not throw
    await watcher.stop();
  });

  it('stop() is idempotent', async () => {
    const watcher = new ContextWatcher({ contextDir: tmp });
    await watcher.stop();
    await watcher.stop(); // should not throw
  });
});
/**
 * recorder/service.ts — unit tests.
 *
 * The hook worker and focus tracker are injected/mocked so no real
 * subprocess or PowerShell runs. Covers the start/stop state machine,
 * focus-driven flush ordering, self-window and blocked-app filters,
 * password redaction hand-off, degraded flag, and the session files
 * written to a tmp root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../../logging/logger', () => {
  const noop = () => undefined;
  return {
    getLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop, fatal: noop }),
    LogComponent: { ComputerUse: 'ComputerUse' },
  };
});

vi.mock('../recorder/focus-tracker.js', () => {
  const instances: Array<Record<string, unknown>> = [];
  class MockTracker {
    onChangeCb: (prev: unknown, next: unknown) => void;
    constructor(opts: { onChange: (prev: unknown, next: unknown) => void }) {
      this.onChangeCb = opts.onChange;
      instances.push(this as unknown as Record<string, unknown>);
    }
    onChange(prev: unknown, next: unknown): void {
      this.onChangeCb(prev, next);
    }
    start(): void {}
    async stop(): Promise<void> {}
  }
  return {
    RecorderFocusTracker: MockTracker,
    FOCUS_POLL_INTERVAL_MS: 500,
    __mockInstances: instances,
  };
});

import { RecorderService, DEFAULT_MAX_DURATION_MS } from '../recorder/service';
import { listSessions, loadSession } from '@duya/computer-use';
import type { AppRef } from '@duya/computer-use';
import type { UiaEnumerateResult } from '../recorder/uia-probe.js';

const mockModule = (await import('../recorder/focus-tracker.js')) as unknown as {
  __mockInstances: Array<Record<string, unknown>>;
};

type WorkerCbs = {
  onEvent: (event: Record<string, unknown>) => void;
  onCrash: () => void;
  onFailed: (reason: string) => void;
};

function keydown(keycode: number, char: string | null, ts: number, opts: Record<string, unknown> = {}) {
  return {
    kind: 'keydown',
    ts,
    keycode,
    name: null,
    char,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...opts,
  };
}

const CHROME = { hwnd: 1, pid: 100, processName: 'chrome', title: 'Docs' };
const NOTEPAD = { hwnd: 2, pid: 200, processName: 'notepad', title: 'notes.txt' };

let rootDir: string;
let workerCbs: WorkerCbs | null = null;
let workerStarts = 0;
let workerStops = 0;

beforeEach(async () => {
  rootDir = join(tmpdir(), `duya-recorder-test-${randomUUID()}`);
  workerCbs = null;
  workerStarts = 0;
  workerStops = 0;
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function makeService(overrides: Record<string, unknown> = {}): RecorderService {
  return new RecorderService({
    rootDir,
    createWorker: (cbs) => {
      workerCbs = cbs;
      return {
        start: async () => {
          workerStarts += 1;
        },
        stop: async () => {
          workerStops += 1;
        },
      };
    },
    ...overrides,
  } as ConstructorParameters<typeof RecorderService>[0]);
}

function tracker(): { onChange: (prev: unknown, next: unknown) => void } {
  const inst = mockModule.__mockInstances.at(-1);
  if (!inst) throw new Error('no tracker instance');
  return inst as unknown as { onChange: (prev: unknown, next: unknown) => void };
}

async function readEvents() {
  const sessions = await listSessions(rootDir);
  expect(sessions.length).toBe(1);
  return loadSession(rootDir, sessions[0]!.sessionId);
}

describe('RecorderService', () => {
  it('start/stop lifecycle: recording → idle, worker started and stopped', async () => {
    const service = makeService();
    const snapshot = await service.start();
    expect(snapshot.status).toBe('recording');
    expect(workerStarts).toBeGreaterThan(0);

    const summary = await service.stop();
    expect(summary).not.toBeNull();
    expect(summary!.endedAt).toBeDefined();
    expect(workerStops).toBe(1);
    expect(service.getSnapshot().status).toBe('idle');
  });

  it('start is single-flight (second call while recording is a no-op)', async () => {
    const service = makeService();
    await service.start();
    expect(workerStarts).toBe(1);
    await service.start();
    expect(workerStarts).toBe(1);
    await service.stop();
  });

  it('records app_focus on focus change and flushes typing into the old app', async () => {
    const service = makeService();
    await service.start();

    tracker().onChange(null, CHROME);
    tracker().onChange(CHROME, NOTEPAD);
    // Type into notepad, then switch away.
    workerCbs!.onEvent(keydown(48, 'o', 1000));
    workerCbs!.onEvent(keydown(37, 'k', 1010));
    tracker().onChange(NOTEPAD, CHROME);

    await service.stop();
    const { events } = await readEvents();
    const kinds = events.map((e) => e.type);
    // [app_focus chrome, app_focus notepad, type(ok), app_focus chrome]
    expect(kinds[0]).toBe('app_focus');
    expect(kinds[1]).toBe('app_focus');
    expect(kinds[2]).toBe('type');
    const typeEvent = events[2]!;
    if (typeEvent.type === 'type') {
      expect(typeEvent.text).toBe('ok');
      expect(typeEvent.app.processName).toBe('notepad');
    } else {
      throw new Error('expected type event');
    }
    expect(kinds[3]).toBe('app_focus');
  });

  it('drops events while a duya window (own pid) is foreground', async () => {
    const service = makeService();
    await service.start();

    const SELF = { hwnd: 3, pid: process.pid, processName: 'DUYA', title: 'duya' };
    tracker().onChange(null, SELF);
    workerCbs!.onEvent(keydown(30, 'a', 1000));
    tracker().onChange(SELF, CHROME);

    await service.stop();
    const { events } = await readEvents();
    expect(events.every((e) => e.app.pid !== process.pid)).toBe(true);
    // no app_focus for the self window, no type event from the self window
    expect(events.filter((e) => e.type === 'app_focus').map((e) => e.app.processName)).toEqual(['chrome']);
    expect(events.filter((e) => e.type === 'type')).toHaveLength(0);
  });

  it('drops events and app_focus for blocked apps (password managers)', async () => {
    const service = makeService();
    await service.start();

    const KEEPASS = { hwnd: 4, pid: 300, processName: 'keepass', title: 'KeePass' };
    tracker().onChange(null, KEEPASS);
    workerCbs!.onEvent(keydown(30, 'a', 1000));
    tracker().onChange(KEEPASS, CHROME);

    await service.stop();
    const { events } = await readEvents();
    expect(events.some((e) => e.type === 'app_focus' && e.app.processName === 'keepass')).toBe(false);
    expect(events.filter((e) => e.type === 'type')).toHaveLength(0);
  });

  it('marks degraded when the worker exhausts its restart budget', async () => {
    const service = makeService();
    await service.start();
    expect(service.getSnapshot().degraded).toBe(false);
    workerCbs!.onFailed('hook worker died twice (code=1)');
    expect(service.getSnapshot().degraded).toBe(true);
    // recording continues
    expect(service.getSnapshot().status).toBe('recording');
    await service.stop();
  });

  it('auto-stops at the max duration cap', async () => {
    vi.useRealTimers();
    const service = makeService({ maxDurationMs: 60 });
    await service.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(service.getSnapshot().status).toBe('idle');
    // stop() after an auto-stop is a no-op returning null.
    expect(await service.stop()).toBeNull();
    const sessions = await listSessions(rootDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAt).toBeDefined();
  }, 5000);

  it('writes session.json summary with event counts', async () => {
    const service = makeService();
    await service.start();
    tracker().onChange(null, CHROME);
    workerCbs!.onEvent(keydown(30, 'a', 1000));
    await service.stop();

    const sessions = await listSessions(rootDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.eventCount).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.apps[0]).toMatchObject({ processName: 'chrome' });
  });

  it('default max duration is 10 minutes', () => {
    expect(DEFAULT_MAX_DURATION_MS).toBe(10 * 60_000);
  });
});

describe('RecorderService — probe wiring (phase 2)', () => {
  function mouseDown(ts: number) {
    return { kind: 'mousedown', ts, x: 50, y: 60, button: 1, clicks: 1 };
  }
  function mouseUp(ts: number) {
    return { kind: 'mouseup', ts, x: 50, y: 60, button: 1 };
  }

  it('attaches the probed element to click events', async () => {
    const service = makeService({
      probe: {
        at: async () => ({
          name: '确定',
          controlType: 'Button',
          className: 'Button',
          isPassword: false,
          source: 'uia-probe',
        }),
      },
    });
    await service.start();
    tracker().onChange(null, CHROME);
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    await service.stop();

    const { events } = await readEvents();
    const click = events.find((e) => e.type === 'click');
    expect(click).toBeDefined();
    if (click?.type === 'click') {
      expect(click.element).toMatchObject({ name: '确定', source: 'uia-probe' });
    }
  });

  it('a password element flips redaction for the typing that follows', async () => {
    const service = makeService({
      probe: {
        at: async () => ({ name: 'pw', controlType: 'Edit', isPassword: true, source: 'uia-probe' }),
      },
    });
    await service.start();
    tracker().onChange(null, CHROME);
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    // Real timeline: the probe result lands within its budget, BEFORE
    // the user starts typing into the (password) field. The enrich
    // chain resolves across real I/O ticks, so poll for it.
    for (let i = 0; i < 40 && (service as unknown as { redactHint: boolean }).redactHint !== true; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    workerCbs!.onEvent(keydown(30, 'a', 920));
    workerCbs!.onEvent(keydown(30, 'b', 930));
    tracker().onChange(CHROME, NOTEPAD); // flush trigger
    await service.stop();

    const { events } = await readEvents();
    const clickEvent = events.find((e) => e.type === 'click');
    expect(clickEvent).toBeDefined();
    if (clickEvent?.type === 'click') {
      // sanity: the probe result must have attached, proving enrich ran
      expect(clickEvent.element).toMatchObject({ name: 'pw', isPassword: true });
    }
    const typeEvent = events.find((e) => e.type === 'type');
    expect(typeEvent).toBeDefined();
    if (typeEvent?.type === 'type') {
      expect(typeEvent.text).toBe('<redacted>');
    }
  });

  it('attaches browserUrl to click events while a browser is foreground', async () => {
    const service = makeService({
      probe: {
        at: async () => ({ source: 'none' }),
        readUrl: async () => 'https://example.com/page',
      },
    });
    await service.start();
    tracker().onChange(null, CHROME);
    // let the async readUrl resolve before feeding events
    await new Promise((r) => setImmediate(r));
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    await service.stop();

    const { events } = await readEvents();
    const click = events.find((e) => e.type === 'click');
    expect(click).toBeDefined();
    if (click?.type === 'click') {
      expect(click.browserUrl).toBe('https://example.com/page');
    }
  });

  it('does not attach browserUrl outside browser apps', async () => {
    const service = makeService({
      probe: {
        at: async () => ({ source: 'none' }),
        readUrl: async () => 'https://example.com/page',
      },
    });
    await service.start();
    tracker().onChange(null, NOTEPAD);
    await new Promise((r) => setImmediate(r));
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    await service.stop();

    const { events } = await readEvents();
    const click = events.find((e) => e.type === 'click');
    expect(click).toBeDefined();
    if (click?.type === 'click') {
      expect(click.browserUrl).toBeUndefined();
    }
  });
});

describe('RecorderService — app_focus enumerate snapshot (plan 562 phase 5)', () => {
  it('fires an async enumerate on focus change and delivers a non-empty snapshot', async () => {
    const enumerate = vi.fn(async (_hwnd: number, _title: string) => ({
      elements: [{ name: 'OK', controlType: 'Button', rect: { x: 1, y: 2, w: 3, h: 4 }, interactive: true, source: 'uia-probe' }],
      truncated: false,
      reason: null,
    }));
    const snapshots: Array<{ hwnd: number; title: string; elements: unknown[] }> = [];
    const service = makeService({
      probe: {
        at: async () => ({ source: 'none' }),
        enumerate: (hwnd: number, title: string) => enumerate(hwnd, title),
      },
      onEnumerateSnapshot: (result: UiaEnumerateResult, app: AppRef) => {
        snapshots.push({ hwnd: app.pid, title: app.title, elements: result.elements });
      },
    });
    await service.start();
    tracker().onChange(null, CHROME);
    await new Promise((r) => setImmediate(r));
    expect(enumerate).toHaveBeenCalledWith(CHROME.hwnd, CHROME.title);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.title).toBe('Docs');
    expect(snapshots[0]!.elements).toHaveLength(1);
    await service.stop();
  });

  it('suppresses the callback for empty trees and self/blocked apps', async () => {
    const enumerate = vi.fn(async () => ({ elements: [], truncated: false, reason: null }));
    const onSnapshot = vi.fn();
    const service = makeService({
      probe: {
        at: async () => ({ source: 'none' }),
        enumerate: () => enumerate(),
      },
      onEnumerateSnapshot: onSnapshot,
    });
    await service.start();
    // Empty tree → no callback.
    tracker().onChange(null, CHROME);
    await new Promise((r) => setImmediate(r));
    expect(onSnapshot).not.toHaveBeenCalled();
    // Self window → enumerate not even attempted.
    const SELF = { hwnd: 3, pid: process.pid, processName: 'DUYA', title: 'duya' };
    tracker().onChange(CHROME, SELF);
    await new Promise((r) => setImmediate(r));
    expect(enumerate).toHaveBeenCalledTimes(1);
    // Blocked app → enumerate not attempted either.
    const KEEPASS = { hwnd: 4, pid: 300, processName: 'keepass', title: 'KeePass' };
    tracker().onChange(SELF, KEEPASS);
    await new Promise((r) => setImmediate(r));
    expect(enumerate).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('enumerate failures never break the append chain', async () => {
    const service = makeService({
      probe: {
        at: async () => ({ source: 'none' }),
        enumerate: async () => {
          throw new Error('probe dead');
        },
      },
      onEnumerateSnapshot: () => undefined,
    });
    await service.start();
    tracker().onChange(null, CHROME);
    await new Promise((r) => setTimeout(r, 20));
    workerCbs!.onEvent(keydown(48, 'o', 1000));
    tracker().onChange(CHROME, NOTEPAD);
    await service.stop();
    const { events } = await readEvents();
    // The type event still landed — the failed snapshot was swallowed.
    expect(events.some((e) => e.type === 'type')).toBe(true);
  });
});

describe('RecorderService — click-driven browserUrl refresh (plan 562 §7)', () => {
  function mouseDown(ts: number, button = 1) {
    return { kind: 'mousedown', ts, x: 50, y: 60, button, clicks: 1 };
  }
  function mouseUp(ts: number, button = 1) {
    return { kind: 'mouseup', ts, x: 50, y: 60, button };
  }

  it('a left mouseup in a browser triggers a throttled readUrl refresh', async () => {
    const readUrl = vi.fn(async () => 'https://old.example/a');
    const service = makeService({
      probe: { at: async () => ({ source: 'none' }), readUrl },
      urlRefreshIntervalMs: 50,
    });
    await service.start();
    // Focus-change refresh (#1) → browserUrl = old/a.
    tracker().onChange(null, CHROME);
    await new Promise((r) => setImmediate(r));
    expect(readUrl).toHaveBeenCalledTimes(1);
    expect((service as unknown as { browserUrl?: string }).browserUrl).toBe('https://old.example/a');

    // Simulated navigation completes, then the click lands → refresh (#2).
    readUrl.mockResolvedValue('https://new.example/b');
    await new Promise((r) => setTimeout(r, 60));
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    await new Promise((r) => setImmediate(r));
    expect(readUrl).toHaveBeenCalledTimes(2);
    expect(readUrl).toHaveBeenLastCalledWith(CHROME.hwnd);
    expect((service as unknown as { browserUrl?: string }).browserUrl).toBe('https://new.example/b');

    // Throttle: an immediate second click does not re-read.
    workerCbs!.onEvent(mouseDown(920));
    workerCbs!.onEvent(mouseUp(930));
    await new Promise((r) => setImmediate(r));
    expect(readUrl).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it('right-button mouseups and non-browser foregrounds never refresh', async () => {
    const readUrl = vi.fn(async () => 'https://old.example/a');
    const service = makeService({
      probe: { at: async () => ({ source: 'none' }), readUrl },
    });
    await service.start();
    // Non-browser: no readUrl on focus change, none on left click either.
    tracker().onChange(null, NOTEPAD);
    await new Promise((r) => setImmediate(r));
    workerCbs!.onEvent(mouseDown(900));
    workerCbs!.onEvent(mouseUp(910));
    await new Promise((r) => setImmediate(r));
    expect(readUrl).not.toHaveBeenCalled();

    // Browser focus change fires readUrl (#1).
    tracker().onChange(NOTEPAD, CHROME);
    await new Promise((r) => setImmediate(r));
    expect(readUrl).toHaveBeenCalledTimes(1);

    // Right-button click is not a navigation click: no refresh.
    workerCbs!.onEvent(mouseDown(920, 2));
    workerCbs!.onEvent(mouseUp(930, 2));
    await new Promise((r) => setImmediate(r));
    expect(readUrl).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});

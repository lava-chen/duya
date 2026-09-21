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

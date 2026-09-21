/**
 * recorder-handlers.test.ts — plan 556 Phase 5 gate: the recorder IPC
 * surface (start / stop / cancel / status / list / get / delete /
 * convert) against a mocked recorder service, badge and session store.
 *
 * The badge and the recorder service are mocked because both touch real
 * OS resources (a native hook worker, a UIA probe, an always-on-top
 * window); the conversion runs against the REAL converter, so the test
 * proves the handler hands the UI a schema-valid definition.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { validateWorkflow } from '../../../packages/agent/src/modes/workflow/validate';

// ─── harness (vi.hoisted: mock factories are hoisted above the consts) ───

const h = vi.hoisted(() => ({
  registered: [] as string[],
  handlers: new Map<string, (_e: unknown, payload?: unknown) => unknown>(),
  badge: {
    shown: 0,
    hidden: 0,
    updates: [] as unknown[],
    handlers: null as { onStop: () => void; onCancel: () => void } | null,
  },
  recorder: {
    snapshot: {
      status: 'idle',
      sessionId: null as string | null,
      startedAt: null as number | null,
      durationMs: null as number | null,
      eventCount: 0,
      degraded: false,
    },
    started: 0,
    stopped: 0,
    statusListeners: [] as Array<(snapshot: unknown) => void>,
  },
  store: {
    deleted: [] as string[],
    events: [] as unknown[],
    dropped: [] as unknown[],
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (_e: unknown, payload?: unknown) => unknown) => {
      h.registered.push(channel);
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  LogComponent: { Main: 'Main', ComputerUse: 'ComputerUse' },
}));

vi.mock('../../services/recorder/badge', () => ({
  showRecorderBadge: () => {
    h.badge.shown++;
  },
  hideRecorderBadge: () => {
    h.badge.hidden++;
  },
  updateRecorderBadge: (snapshot: unknown) => {
    h.badge.updates.push(snapshot);
  },
  setRecorderBadgeHandlers: (next: { onStop: () => void; onCancel: () => void }) => {
    h.badge.handlers = next;
  },
}));

vi.mock('../../services/recorder/service', () => ({
  getRecorderService: () => ({
    start: async () => {
      h.recorder.started++;
      h.recorder.snapshot = {
        status: 'recording',
        sessionId: 'sess-1',
        startedAt: 1_000,
        durationMs: 0,
        eventCount: 0,
        degraded: false,
      };
      return h.recorder.snapshot;
    },
    stop: async () => {
      h.recorder.stopped++;
      const sessionId = h.recorder.snapshot.sessionId;
      h.recorder.snapshot = { ...h.recorder.snapshot, status: 'idle', sessionId: null, durationMs: 4_000 };
      return { sessionId, startedAt: 1_000, endedAt: 5_000, eventCount: 3, apps: [] };
    },
    getSnapshot: () => h.recorder.snapshot,
    onStatus: (listener: (snapshot: unknown) => void) => {
      h.recorder.statusListeners.push(listener);
      return () => {};
    },
    dispose: async () => {},
  }),
}));

// Partial mock: the session-store functions are stubbed, but the
// converter (imported by the handler) needs the REAL zod schemas from
// this package, so everything else stays authentic.
vi.mock('@duya/computer-use', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@duya/computer-use')>();
  return {
    ...actual,
    getDefaultRecorderRootDir: () => 'C:/recorder-root',
    listSessions: async () => [
      { sessionId: 'sess-1', startedAt: 1_000, endedAt: 5_000, eventCount: 3, apps: [] },
    ],
    loadSession: async (_root: string, sessionId: string) => {
      if (sessionId === 'missing') throw new Error('ENOENT');
      return {
        summary: {
          sessionId,
          startedAt: 1_000,
          endedAt: 5_000,
          eventCount: h.store.events.length,
          apps: [],
        },
        events: h.store.events,
        dropped: h.store.dropped,
      };
    },
    deleteSession: async (_root: string, sessionId: string) => {
      h.store.deleted.push(sessionId);
    },
  };
});

// Imported AFTER the mocks so the module graph picks them up.
const { registerRecorderHandlers } = await import('../recorder-handlers');

// ─── fixtures ───

const sessionId = 'sess-1';

/** One app_focus + one click — the smallest convertible session. */
function clickSession(): unknown[] {
  return [
    { type: 'app_focus', ts: 1, app: { name: 'Chrome', title: 'Invoice', processName: 'chrome', pid: 10 } },
    {
      type: 'click',
      ts: 2,
      app: { name: 'Chrome', title: 'Invoice', processName: 'chrome', pid: 10 },
      click: { x: 120, y: 240, button: 'left', count: 1 },
      element: { source: 'uia-probe', name: 'Submit', controlType: 'Button' },
    },
  ];
}

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} not registered`);
  return Promise.resolve(fn(undefined, payload));
}

describe('recorder IPC handlers', () => {
  beforeEach(() => {
    h.registered.length = 0;
    h.handlers.clear();
    h.badge.shown = 0;
    h.badge.hidden = 0;
    h.badge.updates.length = 0;
    h.badge.handlers = null;
    h.recorder.started = 0;
    h.recorder.stopped = 0;
    h.recorder.statusListeners.length = 0;
    h.recorder.snapshot = {
      status: 'idle',
      sessionId: null,
      startedAt: null,
      durationMs: null,
      eventCount: 0,
      degraded: false,
    };
    h.store.deleted.length = 0;
    h.store.events = clickSession();
    h.store.dropped.length = 0;
    registerRecorderHandlers();
  });

  it('registers exactly the recorder channels', () => {
    expect([...h.registered].sort()).toEqual(
      [
        'recorder:cancel',
        'recorder:convert',
        'recorder:delete-session',
        'recorder:get-session',
        'recorder:list-sessions',
        'recorder:start',
        'recorder:status',
        'recorder:stop',
      ].sort(),
    );
  });

  it('start shows the badge and returns the live snapshot', async () => {
    const result = (await invoke('recorder:start')) as { ok: boolean; status: { status: string } };
    expect(result.ok).toBe(true);
    expect(result.status.status).toBe('recording');
    expect(h.badge.shown).toBe(1);
    expect(h.recorder.started).toBe(1);
  });

  it('stop hides the badge and keeps the session', async () => {
    await invoke('recorder:start');
    const result = (await invoke('recorder:stop')) as { ok: boolean; summary: { sessionId: string } };
    expect(result.ok).toBe(true);
    expect(result.summary.sessionId).toBe(sessionId);
    expect(h.badge.hidden).toBeGreaterThanOrEqual(1);
    // Keeping the session means NOT touching the session store.
    expect(h.store.deleted).toEqual([]);
  });

  it('cancel deletes the session id captured before stop cleared it', async () => {
    await invoke('recorder:start');
    const result = (await invoke('recorder:cancel')) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(h.store.deleted).toEqual([sessionId]);
    expect(h.badge.hidden).toBeGreaterThanOrEqual(1);
  });

  it('status / list / delete pass straight through', async () => {
    expect((await invoke('recorder:status')) as { status: string }).toMatchObject({ status: 'idle' });
    expect(await invoke('recorder:list-sessions')).toHaveLength(1);
    expect(await invoke('recorder:delete-session', sessionId)).toEqual({ ok: true });
    expect(h.store.deleted).toEqual([sessionId]);
    expect(await invoke('recorder:delete-session', '')).toMatchObject({ ok: false });
  });

  it('get-session returns the parsed session, and null on failure', async () => {
    const loaded = (await invoke('recorder:get-session', sessionId)) as { events: unknown[] };
    expect(loaded.events).toHaveLength(2);
    expect(await invoke('recorder:get-session', 'missing')).toBeNull();
    expect(await invoke('recorder:get-session', '')).toBeNull();
  });

  it('convert produces a schema-valid definition plus its YAML', async () => {
    const result = (await invoke('recorder:convert', { sessionId })) as {
      ok: boolean;
      def: unknown;
      yaml: string;
      eventCount: number;
      droppedLines: number;
    };
    expect(result.ok).toBe(true);
    expect(result.eventCount).toBe(2);
    expect(result.droppedLines).toBe(0);

    // The YAML the user reviews is exactly what the registry would write.
    const reparsed = parseYaml(result.yaml);
    expect(reparsed).toEqual(result.def);
    expect(validateWorkflow(reparsed).ok).toBe(true);

    const def = result.def as {
      phases: Array<{ nodes: Array<{ gui?: { steps: Array<{ do: string }> } }> }>;
    };
    expect(def.phases[0]!.nodes[0]!.gui!.steps.map((step) => step.do)).toEqual(['capture', 'click']);
  });

  it('convert honours a caller-supplied name', async () => {
    const result = (await invoke('recorder:convert', { sessionId, name: 'my-recorded-flow' })) as {
      ok: boolean;
      def: { name: string };
    };
    expect(result.ok).toBe(true);
    expect(result.def.name).toBe('my-recorded-flow');
  });

  it('convert fails cleanly when nothing was recorded', async () => {
    h.store.events = [];
    const result = (await invoke('recorder:convert', { sessionId })) as {
      ok: boolean;
      errors: Array<{ message: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain('no interactive events');
  });

  it('convert rejects an invalid payload without touching the disk', async () => {
    expect(await invoke('recorder:convert', { sessionId: '' })).toMatchObject({ ok: false });
    expect(await invoke('recorder:convert', undefined)).toMatchObject({ ok: false });
  });

  it('the status fan-out feeds the badge', () => {
    expect(h.recorder.statusListeners).toHaveLength(1);
    h.recorder.statusListeners[0]!({
      status: 'recording',
      sessionId: 'sess-1',
      startedAt: 1_000,
      durationMs: 65_000,
      eventCount: 12,
      degraded: false,
    });
    expect(h.badge.updates.at(-1)).toMatchObject({ duration: '01:05', eventCount: 12, degraded: false });
  });

  it('the badge buttons drive stop and discard', async () => {
    await invoke('recorder:start');
    expect(h.badge.handlers).not.toBeNull();
    h.badge.handlers!.onCancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.deleted).toEqual([sessionId]);
  });
});

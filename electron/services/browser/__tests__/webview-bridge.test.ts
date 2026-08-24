/**
 * Unit tests for the webview bridge's registration hold and page-load wait.
 *
 * The electron module and structured logger are mocked; HTTP req/res are
 * minimal fakes shaped after what the handlers actually touch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  wcRegistry: new Map<number, unknown>(),
}));

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => mocks.wcRegistry.get(id) },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: { BrowserDaemon: 'BrowserDaemon' },
}));

import {
  registerWebviewSession,
  unregisterWebviewSession,
  handleWebviewCommand,
  handleWebviewWaitLoad,
  setRegistrationHoldTimeoutForTest,
  REGISTRATION_HOLD_TIMEOUT_MS,
} from '../webview-bridge';

// ─── Fakes ───────────────────────────────────────────────────────────

interface FakeWc {
  isDestroyed(): boolean;
  once(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocol: string): void;
    detach(): void;
    on(event: string, fn: (...args: unknown[]) => void): void;
    removeListener(event: string, fn: (...args: unknown[]) => void): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  emitCdpMessage(method: string, params?: unknown): void;
}

/** Build a fake webContents whose Runtime.evaluate answers via `evaluateImpl`. */
function makeFakeWc(evaluateImpl: (expression: string) => unknown): FakeWc {
  const cdpListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const destroyedListeners = new Set<(...args: unknown[]) => void>();
  let attached = false;
  let impl = evaluateImpl;

  const wc: FakeWc = {
    isDestroyed: () => false,
    once: (event, fn) => {
      if (event === 'destroyed') destroyedListeners.add(fn);
    },
    removeListener: (event, fn) => {
      if (event === 'destroyed') destroyedListeners.delete(fn);
    },
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {},
      on: (event, fn) => {
        if (!cdpListeners.has(event)) cdpListeners.set(event, new Set());
        cdpListeners.get(event)!.add(fn);
      },
      removeListener: (event, fn) => {
        cdpListeners.get(event)?.delete(fn);
      },
      sendCommand: async (method, params) => {
        if (method === 'Runtime.evaluate') {
          return impl(String((params as { expression?: string } | undefined)?.expression ?? ''));
        }
        return {};
      },
    },
    emitCdpMessage: (method, params) => {
      for (const fn of cdpListeners.get('message') ?? []) fn({}, method, params);
    },
  };
  // Allow swapping evaluate answers mid-test (loading → complete transitions).
  (wc as { setEvaluateImpl(fn: (expression: string) => unknown): void }).setEvaluateImpl =
    (fn: (expression: string) => unknown) => {
      impl = fn;
    };
  return wc;
}

function makeReq(body: unknown, url = '/webview-wait-load'): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as IncomingMessage & {
    method?: string;
    url?: string;
  };
  stream.method = 'POST';
  stream.url = url;
  return stream as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; status(): number; body(): string } {
  const state = { statusCode: 0, payload: '' };
  const res = {
    writeHead(code: number) {
      state.statusCode = code;
    },
    end(payload?: string) {
      state.payload = payload ?? '';
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => state.statusCode,
    body: () => state.payload,
  };
}

function makeMainWindow(): {
  win: never;
  sent: Array<{ channel: string; payload: Record<string, unknown> }>;
} {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload });
      },
    },
  };
  return { win: win as never, sent };
}

function putWc(id: number, wc: FakeWc): void {
  mocks.wcRegistry.set(id, wc);
}

/** Yield long enough for the body-read + routing chain to reach its wait point. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  setRegistrationHoldTimeoutForTest(REGISTRATION_HOLD_TIMEOUT_MS);
});

afterEach(() => {
  setRegistrationHoldTimeoutForTest(REGISTRATION_HOLD_TIMEOUT_MS);
});

// ─── Registration hold (/webview-command) ────────────────────────────

describe('handleWebviewCommand registration hold', () => {
  const baseCommand = {
    id: 'cmd-1',
    sessionId: 'sess-hold',
    method: 'Page.navigate',
    params: { url: 'https://example.com' },
  };

  afterEach(() => {
    unregisterWebviewSession('sess-hold');
    unregisterWebviewSession('sess-plain');
  });

  it('holds a waitRegistration command, executes after the session registers', async () => {
    const wc = makeFakeWc(() => ({ result: { value: 'complete' } }));
    let executed: Array<[string, unknown]> = [];
    wc.debugger.sendCommand = async (method, params) => {
      executed.push([method, params]);
      return { result: {} };
    };
    putWc(101, wc);

    const { win, sent } = makeMainWindow();
    const { res, status, body } = makeRes();

    const handled = handleWebviewCommand(
      makeReq({ ...baseCommand, waitRegistration: true }, '/webview-command'),
      res,
      win,
    );
    await settle();
    expect(sent.some(s => s.channel === 'browser:open-agent-tab')).toBe(true);

    registerWebviewSession('sess-hold', 101);
    expect(await handled).toBe(true);
    expect(status()).toBe(200);

    const payload = JSON.parse(body()) as { ok?: boolean; result?: unknown };
    expect(payload.ok).toBe(true);
    expect(executed[0][0]).toBe('Page.navigate');
    expect(sent.some(s => s.channel === 'browser:activate-agent-tab')).toBe(true);
  });

  it('returns held:true 404 when the hold window expires without registration', async () => {
    setRegistrationHoldTimeoutForTest(30);
    const { win, sent } = makeMainWindow();
    const { res, status, body } = makeRes();

    const handled = handleWebviewCommand(
      makeReq({ ...baseCommand, waitRegistration: true }, '/webview-command'),
      res,
      win,
    );
    await settle();
    expect(sent.some(s => s.channel === 'browser:open-agent-tab')).toBe(true);

    expect(await handled).toBe(true);
    expect(status()).toBe(404);
    const payload = JSON.parse(body()) as { error?: string; held?: boolean };
    expect(payload.error).toBe('WEBVIEW_SESSION_NOT_REGISTERED');
    expect(payload.held).toBe(true);
  });

  it('answers plain 404 immediately when waitRegistration is not requested', async () => {
    const { win } = makeMainWindow();
    const { res, status, body } = makeRes();

    const handled = handleWebviewCommand(
      makeReq({ ...baseCommand, sessionId: 'sess-plain' }, '/webview-command'),
      res,
      win,
    );
    expect(await handled).toBe(true);
    expect(status()).toBe(404);
    const payload = JSON.parse(body()) as { error?: string; held?: boolean };
    expect(payload.error).toBe('WEBVIEW_SESSION_NOT_REGISTERED');
    expect(payload.held).toBeUndefined();
  });
});

// ─── Page-load wait (/webview-wait-load) ─────────────────────────────

describe('handleWebviewWaitLoad', () => {
  afterEach(() => {
    unregisterWebviewSession('sess-load');
  });

  it('returns immediately when the page already finished loading', async () => {
    const wc = makeFakeWc(expression =>
      expression.includes('readyState') ? { result: { value: 'complete' } } : {},
    );
    putWc(201, wc);
    registerWebviewSession('sess-load', 201);

    const { res, status, body } = makeRes();
    const handled = await handleWebviewWaitLoad(
      makeReq({ sessionId: 'sess-load', timeoutMs: 5000 }),
      res,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const payload = JSON.parse(body()) as { ok?: boolean; timedOut?: boolean; readyState?: string };
    expect(payload.ok).toBe(true);
    expect(payload.timedOut).toBe(false);
    expect(payload.readyState).toBe('complete');
  });

  it('resolves from the Page.loadEventFired event after loading completes', async () => {
    let readyState = 'loading';
    const wc = makeFakeWc(expression =>
      expression.includes('readyState') ? { result: { value: readyState } } : {},
    );
    putWc(202, wc);
    registerWebviewSession('sess-load', 202);

    const { res, body } = makeRes();
    const handled = handleWebviewWaitLoad(
      makeReq({ sessionId: 'sess-load', timeoutMs: 5000 }),
      res,
    );

    // Let the handler subscribe, then fire the load event and flip readyState.
    await new Promise(resolve => setTimeout(resolve, 20));
    readyState = 'complete';
    wc.emitCdpMessage('Page.loadEventFired');

    expect(await handled).toBe(true);
    const payload = JSON.parse(body()) as { ok?: boolean; timedOut?: boolean; readyState?: string };
    expect(payload.ok).toBe(true);
    expect(payload.timedOut).toBe(false);
    expect(payload.readyState).toBe('complete');
  });

  it('reports timedOut when the page never reaches complete within the budget', async () => {
    const wc = makeFakeWc(expression =>
      expression.includes('readyState') ? { result: { value: 'loading' } } : {},
    );
    putWc(203, wc);
    registerWebviewSession('sess-load', 203);

    const { res, body } = makeRes();
    const handled = await handleWebviewWaitLoad(
      makeReq({ sessionId: 'sess-load', timeoutMs: 0 }),
      res,
    );
    expect(handled).toBe(true);
    const payload = JSON.parse(body()) as { ok?: boolean; timedOut?: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.timedOut).toBe(true);
  });

  it('answers 404 for an unregistered session', async () => {
    const { res, status, body } = makeRes();
    const handled = await handleWebviewWaitLoad(
      makeReq({ sessionId: 'never-registered', timeoutMs: 1000 }),
      res,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(404);
    const payload = JSON.parse(body()) as { error?: string };
    expect(payload.error).toBe('WEBVIEW_SESSION_NOT_REGISTERED');
  });

  it('returns false for non-matching routes', async () => {
    const { res } = makeRes();
    const handled = await handleWebviewWaitLoad(
      makeReq({ sessionId: 'x' }, '/some-other-endpoint'),
      res,
    );
    expect(handled).toBe(false);
  });
});

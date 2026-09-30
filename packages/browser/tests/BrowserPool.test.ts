/**
 * BrowserPool session lifecycle regression tests.
 *
 * Covers the idle-timer keying bug: acquireSession must cancel the reused
 * session's OWN idle timer (keyed by session id), otherwise a pooled session
 * could be closed mid-use when its 5-minute idle timer fires after re-acquire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserPool } from '../../src/tool/BrowserTool/BrowserPool.js';
import type { ICDPClient } from '../../src/tool/BrowserTool/CDPClient.js';

vi.mock('../../src/tool/BrowserTool/CDPClient.js', () => ({
  createCDPClientForMode: vi.fn(),
}));

import { createCDPClientForMode } from '../../src/tool/BrowserTool/CDPClient.js';

function makeClient(): ICDPClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ status: 'ok', mode: 'webview' }),
    navigate: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockResolvedValue('complete'),
    screenshot: vi.fn().mockResolvedValue(''),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockResolvedValue('https://example.com/'),
    getTitle: vi.fn().mockResolvedValue('Example'),
    close: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    newTab: vi.fn().mockResolvedValue('tab_1'),
    closeTab: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    startNetworkCapture: vi.fn().mockResolvedValue(true),
    readNetworkCapture: vi.fn().mockResolvedValue([]),
    getCookies: vi.fn().mockResolvedValue([]),
    frames: vi.fn().mockResolvedValue([]),
    evaluateInFrame: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    waitForElement: vi.fn().mockResolvedValue(undefined),
    waitForLoad: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    cdp: vi.fn().mockResolvedValue({}),
  } as unknown as ICDPClient;
}

describe('BrowserPool session reuse vs idle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createCDPClientForMode).mockReset();
    vi.mocked(createCDPClientForMode).mockImplementation(async () => makeClient());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not close a reused session while it is busy again', async () => {
    const pool = new BrowserPool('built-in');
    const anyPool = pool as unknown as {
      acquireSession(id: string): Promise<{ id: string }>;
      releaseSession(s: { id: string }): void;
    };

    // Create a session, then release it — release starts the 5-min idle timer.
    const session = await anyPool.acquireSession('request_a');
    anyPool.releaseSession(session);
    expect(pool.getStats().totalSessions).toBe(1);

    // Re-acquire from a DIFFERENT request id — must return the same pooled
    // session AND cancel its pending idle timer (timers are keyed by session
    // id, not request id).
    const reused = await anyPool.acquireSession('request_b');
    expect(reused).toBe(session);

    // Advance past the original idle window: the reused session must survive.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(pool.getStats().totalSessions).toBe(1);

    await pool.shutdown();
  });

  it('closes an unreused session after the idle timeout', async () => {
    const pool = new BrowserPool('built-in');
    const anyPool = pool as unknown as {
      acquireSession(id: string): Promise<{ id: string }>;
      releaseSession(s: { id: string }): void;
    };

    const session = await anyPool.acquireSession('request_a');
    anyPool.releaseSession(session);
    expect(pool.getStats().totalSessions).toBe(1);

    // No reuse — idle timer fires → session closed.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(pool.getStats().totalSessions).toBe(0);

    await pool.shutdown();
  });
});

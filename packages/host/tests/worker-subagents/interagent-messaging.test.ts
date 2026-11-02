/**
 * The caller's watchdog has to say WHICH failure it is.
 *
 * ## Why this matters
 *
 * The `MessageSession` tool waits on a promise that only a terminal event can
 * settle, and the host's watchdog is what settles it when nothing else
 * does. That watchdog reported one thing for every failure: "interagent
 * local timeout".
 *
 * So an invoke the host never handled — the host had no `interagent:invoke`
 * branch at all — reached the user as a TIMEOUT. The target was not slow;
 * nothing had happened. Reporting both as a timeout is what let a missing
 * server hide behind a symptom that reads like slowness.
 *
 * ## What is pinned here
 *
 * The distinction is made from the frames that actually arrived: none means
 * the invoke was never handled, some means the target was working and ran
 * long.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createWorkerInteragentMessagingPort } from '../../src/worker-tool-services/interagent-messaging.js';
import { getPendingInteragentCall } from '../../src/worker-interagent-calls.js';

const REQUEST = {
  id: 'invoke-1',
  callerSessionId: 'A',
  callerAgentName: 'caller',
  targetSessionId: 'B',
  message: 'hello',
  mode: 'minimal' as const,
  timeout: 1,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the caller distinguishes "never handled" from "too slow"', () => {
  it('reports not_dispatched when nothing ever arrived', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    vi.spyOn(process, 'send').mockImplementation(send as never);

    const port = createWorkerInteragentMessagingPort();
    const pending = port.invoke(REQUEST);

    // The host never answers: no frames, no terminal event.
    await vi.advanceTimersByTimeAsync((REQUEST.timeout + 5) * 1000);

    const result = await pending;
    expect(result.kind).toBe('terminal');
    const event = (result as { terminalEvent: { type: string; code?: string; message?: string } }).terminalEvent;
    expect(event.code).toBe('not_dispatched');
    expect(event.message).toContain('never handled');
  });

  it('reports timeout when the target was working and ran long', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    vi.spyOn(process, 'send').mockImplementation(send as never);

    const port = createWorkerInteragentMessagingPort();
    const pending = port.invoke(REQUEST);

    // The target said something and then went quiet.
    const call = getPendingInteragentCall(REQUEST.id);
    call?.events.push({ type: 'chat:text', sessionId: 'B', content: 'working on it' } as never);

    await vi.advanceTimersByTimeAsync((REQUEST.timeout + 5) * 1000);

    const result = await pending;
    expect(result.kind).toBe('terminal');
    const event = (result as { terminalEvent: { type: string; code?: string } }).terminalEvent;
    expect(event.code).toBe('timeout');
  });

  it('settles on the terminal event without waiting for the watchdog', async () => {
    const send = vi.fn();
    vi.spyOn(process, 'send').mockImplementation(send as never);

    const port = createWorkerInteragentMessagingPort();
    const pending = port.invoke(REQUEST);

    const call = getPendingInteragentCall(REQUEST.id);
    call?.resolveDone({ type: 'chat:done', sessionId: 'B' } as never);

    const result = await pending;
    expect(result.kind).toBe('terminal');
    const event = (result as { terminalEvent: { type: string } }).terminalEvent;
    expect(event.type).toBe('chat:done');
  });
});

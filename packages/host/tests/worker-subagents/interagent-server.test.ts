/**
 * The Host's `interagent:invoke` server.
 *
 * ## Why this server had to exist
 *
 * The standalone Host's worker message handler had no `interagent:invoke`
 * branch, so the `MessageSession` tool's invoke was dropped on the floor. The
 * caller — whose promise only a terminal event can settle — waited out its
 * watchdog and reported "interagent local timeout". That is the one symptom
 * that hides the cause: the tool never worked outside the desktop app, and it
 * failed in a way that looked like the target was slow.
 *
 * ## What these cases pin
 *
 * The server's whole job is the CHANNEL: a refusal has to reach the caller,
 * the target's frames have to reach the caller, and a refusal must not read
 * as silence. A server that dropped either would look exactly like the
 * defect above.
 */

import { describe, expect, it, vi } from 'vitest';
import { InteragentServer, type InteragentServerPorts } from '../../src/worker-interagent-server.js';
import type { StartAgentRunInput, StartAgentRunResult } from '@duya/agent-protocol';

interface Harness {
  readonly server: InteragentServer;
  readonly started: StartAgentRunInput[];
  readonly cancelled: string[];
  readonly sent: Array<{ payload: Record<string, unknown> }>;
  readonly ports: InteragentServerPorts;
}

function createHarness(options?: {
  startResult?: StartAgentRunResult;
  busySessions?: readonly string[];
}): Harness {
  const started: StartAgentRunInput[] = [];
  const cancelled: string[] = [];
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const busy = new Set(options?.busySessions ?? []);

  const ports: InteragentServerPorts = {
    startRun: async (input) => {
      started.push(input);
      return options?.startResult ?? { accepted: true, stage: 'dispatched', runId: 'run-1' as never };
    },
    isSessionBusy: (sessionId) => busy.has(sessionId),
    getWorker: () => ({
      send: (message: unknown) => {
        sent.push({ payload: message as Record<string, unknown> });
      },
    }),
    cancelRun: async (runId) => {
      cancelled.push(runId);
      return { requested: true };
    },
    log: { warn: vi.fn(), info: vi.fn() },
  };

  return { server: new InteragentServer(ports), started, cancelled, sent, ports };
}

const REQUEST = {
  id: 'invoke-1',
  callerSessionId: 'A',
  callerAgentName: 'caller',
  targetSessionId: 'B',
  message: 'what did you do?',
  mode: 'minimal' as const,
  timeout: 60,
};

/** The frames the caller received, in order. */
function events(harness: Harness): Array<Record<string, unknown>> {
  return harness.sent.map((entry) => entry.payload.event as Record<string, unknown>);
}

describe('the inter-agent server drives the target and answers the caller', () => {
  it('starts the target run and forwards its frames to the caller over IPC', async () => {
    const harness = createHarness();

    await harness.server.handleInvoke(REQUEST);

    expect(harness.started).toHaveLength(1);
    expect(harness.started[0]?.sessionId).toBe('B');
    expect(harness.started[0]?.prompt).toBe('what did you do?');

    harness.server.forwardTargetFrame('B', { type: 'chat:text', sessionId: 'B', content: 'hello' });
    harness.server.forwardTargetFrame('B', { type: 'chat:done', sessionId: 'B' });

    expect(harness.sent.map((entry) => entry.payload.type)).toEqual(['interagent:event', 'interagent:event']);
    expect(harness.sent[0]?.payload.id).toBe('invoke-1');
    expect(events(harness)[0]).toEqual({ type: 'chat:text', sessionId: 'B', content: 'hello' });
    expect(events(harness)[1]).toEqual({ type: 'chat:done', sessionId: 'B' });
  });

  it('restricts a minimal invoke to the read-only tools', async () => {
    const harness = createHarness();

    await harness.server.handleInvoke(REQUEST);

    expect(harness.started[0]?.options).toEqual({ allowedTools: ['read', 'grep', 'glob'] });
  });

  it('leaves a full invoke unrestricted', async () => {
    const harness = createHarness();

    await harness.server.handleInvoke({ ...REQUEST, mode: 'full' });

    expect(harness.started[0]?.options).toBeUndefined();
  });

  it('does not forward frames from a session that is not a target', async () => {
    const harness = createHarness();

    await harness.server.handleInvoke(REQUEST);
    harness.server.forwardTargetFrame('C', { type: 'chat:text', sessionId: 'C', content: 'not yours' });

    expect(harness.sent).toHaveLength(0);
  });
});

describe('a refusal reaches the caller instead of silence', () => {
  it('refuses a self-call', async () => {
    const harness = createHarness();

    await harness.server.handleInvoke({ ...REQUEST, targetSessionId: 'A' });

    expect(harness.started).toHaveLength(0);
    expect(events(harness)).toEqual([
      expect.objectContaining({ type: 'chat:error', code: 'self_call' }),
    ]);
  });

  it('refuses a busy target', async () => {
    const harness = createHarness({ busySessions: ['B'] });

    await harness.server.handleInvoke(REQUEST);

    expect(harness.started).toHaveLength(0);
    expect(events(harness)).toEqual([
      expect.objectContaining({ type: 'chat:error', code: 'target_busy' }),
    ]);
  });

  it('refuses a cycle', async () => {
    const harness = createHarness();

    // A calls B, then B calls A: the second edge closes the loop.
    await harness.server.handleInvoke(REQUEST);
    await harness.server.handleInvoke({ ...REQUEST, id: 'invoke-2', callerSessionId: 'B', targetSessionId: 'A' });

    expect(harness.started).toHaveLength(1);
    expect(events(harness)).toEqual([
      expect.objectContaining({ type: 'chat:error', code: 'cycle_detected' }),
    ]);
  });

  it('reports a target that does not exist', async () => {
    const harness = createHarness({
      startResult: { accepted: false, stage: 'refused_no_session', reason: 'session B does not exist' },
    });

    await harness.server.handleInvoke(REQUEST);

    expect(events(harness)).toEqual([
      expect.objectContaining({ type: 'chat:error', code: 'target_not_found' }),
    ]);
  });

  it('reports a refused dispatch with the reason the admission gave', async () => {
    const harness = createHarness({
      startResult: { accepted: false, stage: 'refused_session_busy', reason: 'another run owns this session' },
    });

    await harness.server.handleInvoke(REQUEST);

    expect(events(harness)).toEqual([
      expect.objectContaining({ type: 'chat:error', code: 'dispatch_failed', message: expect.stringContaining('another run owns this session') }),
    ]);
  });
});

describe('an invoke that runs long is stopped', () => {
  it('times out, cancels the target run and tells the caller', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();

      await harness.server.handleInvoke({ ...REQUEST, timeout: 1 });
      vi.advanceTimersByTime(1000);

      expect(harness.cancelled).toEqual(['run-1']);
      expect(events(harness)).toEqual([
        expect.objectContaining({ type: 'chat:error', code: 'timeout' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out an invoke that already settled', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();

      await harness.server.handleInvoke({ ...REQUEST, timeout: 1 });
      harness.server.forwardTargetFrame('B', { type: 'chat:done', sessionId: 'B' });
      vi.advanceTimersByTime(5000);

      expect(harness.cancelled).toEqual([]);
      expect(events(harness)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

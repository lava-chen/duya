import { describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import { createMockHostBridge, type MockHostBridge } from './mock-host-bridge';
import { MOCK_RUNS, MOCK_SESSION_IDS, MOCK_THREADS } from './fixtures';

/** Read a run's events until the bridge stops serving, and join its text. */
async function drainRunText(bridge: MockHostBridge, runId: string): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const batch = await bridge.readRunEvents(runId, cursor);
    if (batch.length === 0) break;
    for (const event of batch) {
      if (event.payload.type !== 'assistant.text_delta') continue;
      parts.push(String((event.payload as { delta: string }).delta));
    }
    cursor = batch[batch.length - 1]!.seq;
  }
  return parts.join('');
}

describe('mock host bridge', () => {
  it('lists the mocked sessions', async () => {
    const bridge = createMockHostBridge();
    const page = await bridge.listSessions();
    expect(page.sessions.length).toBe(MOCK_THREADS.length);
    expect(page.sessions.map((item) => item.session.id)).toContain(MOCK_SESSION_IDS.sidebar);
  });

  it('serves a run script in order and drains it', async () => {
    const bridge = createMockHostBridge();
    const fixture = MOCK_RUNS.find((run) => run.runId === 'mock-run-sidebar');
    expect(fixture).toBeDefined();

    const first = await bridge.readRunEvents(fixture!.runId, 0);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.seq).toBe(1);
    expect(first[0]!.payload.type).toBe('run.started');

    // Every envelope after the cursor is served, and nothing before it.
    const next = await bridge.readRunEvents(fixture!.runId, first[first.length - 1]!.seq);
    expect(next.every((event) => event.seq > first[first.length - 1]!.seq)).toBe(true);
  });

  it('reports a run as running until its script is drained, then completed', async () => {
    const bridge = createMockHostBridge();
    const runId = 'mock-run-sidebar';

    const before = await bridge.listRuns(MOCK_SESSION_IDS.sidebar);
    expect(before[0]!.status).toBe('running');

    // Drain the whole script.
    let cursor = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const batch = await bridge.readRunEvents(runId, cursor);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
    }

    const after = await bridge.listRuns(MOCK_SESSION_IDS.sidebar);
    expect(after[0]!.status).toBe('completed');
  });

  it('keeps a run with an open permission pending', async () => {
    const bridge = createMockHostBridge();
    const runs = await bridge.listRuns(MOCK_SESSION_IDS.approval);
    expect(runs[0]!.status).toBe('running');
  });

  it('lists the pending approval and resolves it', async () => {
    const bridge = createMockHostBridge();
    const pending = await bridge.listPendingApprovals(MOCK_SESSION_IDS.approval);
    expect(pending.length).toBe(1);
    expect(pending[0]!.toolName).toBe('Bash');

    const resolved = await bridge.resolveApproval(pending[0]!.id, { status: 'allow' });
    expect(resolved?.status).toBe('allow');

    const still = await bridge.listPendingApprovals(MOCK_SESSION_IDS.approval);
    expect(still.length).toBe(0);
  });

  /**
   * Resolving an approval must reach the RENDERER, not just the ledger.
   *
   * The permission card reads the run PROJECTION, so the mock publishes the
   * resolution on the run's event stream the way a real Host does. Without
   * this event the card would stay open after the user answered.
   */
  it('publishes the permission resolution on the run event stream', async () => {
    const bridge = createMockHostBridge();
    const pending = await bridge.listPendingApprovals(MOCK_SESSION_IDS.approval);
    expect(pending.length).toBe(1);

    // The request sits at the end of the script, so drain it first.
    const requested: RunEventEnvelope[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const batch = await bridge.readRunEvents('mock-run-approval', cursor);
      if (batch.length === 0) break;
      requested.push(...batch);
      cursor = batch[batch.length - 1]!.seq;
    }
    const request = requested.find((event) => event.payload.type === 'permission.requested');
    expect(request).toBeDefined();

    await bridge.resolveApproval(pending[0]!.id, { status: 'allow' });

    // The resolution lands on the same run, after the request.
    const after = await bridge.readRunEvents('mock-run-approval', request!.seq);
    const resolved = after.find((event) => event.payload.type === 'permission.resolved');
    expect(resolved).toBeDefined();
    expect((resolved!.payload as { action: string }).action).toBe('allow');

    // And the run may now settle.
    const runs = await bridge.listRuns(MOCK_SESSION_IDS.approval);
    expect(runs[0]!.status).toBe('completed');
  });

  it('answers a start with a run whose events replay the prompt', async () => {
    const bridge = createMockHostBridge();
    const result = await bridge.startRun({ sessionId: MOCK_SESSION_IDS.sidebar, prompt: '看看结构' });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    // The reply is chunked, so the echo can sit in any batch. Drain the
    // whole script rather than reading the first window.
    const text = await drainRunText(bridge, result.runId);
    expect(text).toContain('看看结构');
  });

  it('refuses a session update against a stale timestamp', async () => {
    const bridge = createMockHostBridge();
    const stale = await bridge.updateSession(MOCK_SESSION_IDS.sidebar, 1, { title: '新标题' });
    expect(stale).toEqual({ updated: false, reason: 'conflict' });
  });
});

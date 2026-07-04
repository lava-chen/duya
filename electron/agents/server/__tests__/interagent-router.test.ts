import { describe, it, expect, vi } from 'vitest';
import { CycleDetector } from '../interagent-router';

describe('CycleDetector', () => {
  it('rejects self-call', () => {
    const detector = new CycleDetector();
    expect(detector.wouldCreateCycle('A', 'A')).toBe(true);
  });

  it('allows simple A→B call', () => {
    const detector = new CycleDetector();
    expect(detector.wouldCreateCycle('A', 'B')).toBe(false);
  });

  it('rejects A→B→A cycle', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    // B now tries to invoke A — cycle
    expect(detector.wouldCreateCycle('B', 'A')).toBe(true);
  });

  it('rejects A→B→C→A cycle (depth 3)', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    detector.addInvoke('invoke-2', 'B', 'C');
    // C now tries to invoke A — cycle
    expect(detector.wouldCreateCycle('C', 'A')).toBe(true);
  });

  it('allows A→B and C→B (no cycle, shared target)', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    expect(detector.wouldCreateCycle('C', 'B')).toBe(false);
  });

  it('removes invoke from graph on cleanup', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    detector.removeInvoke('invoke-1');
    // After cleanup, B→A is no longer a cycle
    expect(detector.wouldCreateCycle('B', 'A')).toBe(false);
  });
});

import { InteragentRouter, type InvokeParams } from '../interagent-router';
import { SessionState } from '../types';
import type { SessionManager } from '../session-store';
import type { WorkerManager } from '../worker-manager';

function createMockDeps(overrides?: {
  sessionState?: SessionState;
  workerCount?: number;
  sessionExists?: boolean;
}) {
  const sessionState = overrides?.sessionState ?? SessionState.IDLE;
  const sessionExists = overrides?.sessionExists ?? true;

  const sessionManager = {
    getSession: vi.fn(() => sessionExists ? { id: 'B', state: sessionState } : undefined),
    transitionState: vi.fn(),
  } as unknown as SessionManager;

  const workerManager = {
    workerCount: overrides?.workerCount ?? 1,
    spawnWorker: vi.fn(),
    sendCommand: vi.fn(),
    interruptWorker: vi.fn(),
    getWorker: vi.fn(),
    setMessageHandler: vi.fn(),
  } as unknown as WorkerManager;

  const dbRequest = vi.fn();

  return { sessionManager, workerManager, dbRequest };
}

function createParams(overrides?: Partial<InvokeParams>): InvokeParams {
  return {
    id: 'test-invoke-1',
    callerSessionId: 'A',
    callerAgentName: 'caller-agent',
    targetSessionId: 'B',
    message: 'what did you do?',
    mode: 'minimal' as const,
    timeout: 60,
    ...overrides,
  };
}

describe('InteragentRouter rejection', () => {
  it('rejects self-call', async () => {
    const deps = createMockDeps();
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams({ callerSessionId: 'A', targetSessionId: 'A' }));
    expect(result).toEqual({ ok: false, reason: 'self_call' });
  });

  it('rejects when target is STREAMING', async () => {
    const deps = createMockDeps({ sessionState: SessionState.STREAMING });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: false, reason: 'target_busy' });
  });

  it('rejects when target is COMPLETING', async () => {
    const deps = createMockDeps({ sessionState: SessionState.COMPLETING });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: false, reason: 'target_busy' });
  });

  it('rejects when target session not found', async () => {
    const deps = createMockDeps({ sessionExists: false });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: false, reason: 'target_not_found' });
  });

  it('rejects when worker cap reached', async () => {
    const deps = createMockDeps({ workerCount: 16 });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: false, reason: 'server_busy' });
  });

  it('accepts when target is IDLE', async () => {
    const deps = createMockDeps({ sessionState: SessionState.IDLE });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: true });
  });

  it('accepts when target is COMPLETED', async () => {
    const deps = createMockDeps({ sessionState: SessionState.COMPLETED });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: true });
  });
});

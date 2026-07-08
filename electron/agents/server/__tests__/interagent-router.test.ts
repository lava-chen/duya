import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
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
  readyChannel?: 'stdout' | 'ipc' | 'none';
  readyDelayMs?: number;
  stdoutTrailingLines?: string[];
}) {
  const sessionState = overrides?.sessionState ?? SessionState.IDLE;
  const sessionExists = overrides?.sessionExists ?? true;
  const readyChannel = overrides?.readyChannel ?? 'stdout';
  const readyDelayMs = overrides?.readyDelayMs ?? 0;

  const sessionManager = {
    getSession: vi.fn(() => sessionExists ? { id: 'B', state: sessionState } : undefined),
    transitionState: vi.fn(),
  } as unknown as SessionManager;

  // Fake child process: stdout and the child itself are both EventEmitters so
  // waitForReady's dual-subscription (stdout 'data' AND child 'message') can
  // attach and tear down listeners cleanly.
  const fakeStdout = new EventEmitter();
  const fakeChild = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    killed?: boolean;
    stdin?: { writable: boolean };
  };
  fakeChild.stdout = fakeStdout;
  fakeChild.killed = false;
  fakeChild.stdin = { writable: true };

  if (readyChannel === 'stdout') {
    // Wait for the stdout 'data' listener to register, then emit ready.
    // Use process.nextTick so vitest's fake timers don't intercept this
    // (useFakeTimers defaults to faking setTimeout/setInterval/setImmediate
    // but NOT nextTick).
    const originalOn = fakeStdout.on.bind(fakeStdout);
    fakeStdout.on = ((event: string, listener: (...args: unknown[]) => void) => {
      const result = originalOn(event, listener);
      if (event === 'data') {
        process.nextTick(() => {
          fakeStdout.emit('data', Buffer.from(JSON.stringify({ type: 'ready', sessionId: 'B' }) + '\n'));
        });
      }
      return result;
    }) as typeof fakeStdout.on;
  } else if (readyChannel === 'ipc') {
    // Emit ready on the IPC channel after a microtask so waitForReady has
    // a chance to subscribe. nextTick is safe vs fake timers.
    process.nextTick(() => {
      fakeChild.emit('message', { type: 'ready', sessionId: 'B' });
    });
    if (overrides?.stdoutTrailingLines?.length) {
      for (const line of overrides.stdoutTrailingLines) {
        process.nextTick(() => {
          fakeStdout.emit('data', Buffer.from(line + '\n'));
        });
      }
    }
  }
  // 'none' → never ready; used to drive timeout tests.

  const workerManager = {
    workerCount: overrides?.workerCount ?? 1,
    spawnWorker: vi.fn(() => fakeChild),
    sendCommand: vi.fn(),
    interruptWorker: vi.fn(),
    killWorker: vi.fn(),
    getWorker: vi.fn(() => fakeChild),
    hasWorker: vi.fn(() => true),
    setMessageHandler: vi.fn(),
  } as unknown as WorkerManager;

  const dbRequest = vi.fn().mockImplementation((action: string) => {
    if (action === 'session:get') return Promise.resolve({ id: 'B', model: 'test', system_prompt: '', working_directory: '', provider_id: 'test', agent_profile_id: null, permission_profile: 'default' });
    if (action === 'config:provider:get') return Promise.resolve({ id: 'test', name: 'test', providerType: 'anthropic', baseUrl: '', apiKey: 'test-key', isActive: true, options: { defaultModel: 'test' } });
    if (action === 'config:provider:getActive') return Promise.resolve({ id: 'test', name: 'test', providerType: 'anthropic', baseUrl: '', apiKey: 'test-key', isActive: true, options: { defaultModel: 'test' } });
    if (action === 'message:append') return Promise.resolve({ success: true });
    return Promise.resolve(undefined);
  });

  return { sessionManager, workerManager, dbRequest, workerDbRequests: new Map() };
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

describe('InteragentRouter.waitForReady dual-channel', () => {
  // waitForReady is private — invoke it indirectly via handleInvoke on a
  // stub case where the spawnAndDriveTarget path runs to completion.
  it('resolves when ready arrives via child IPC even if stdout never emits it', async () => {
    const deps = createMockDeps({
      sessionState: SessionState.IDLE,
      readyChannel: 'ipc',
      // Some stdout noise that should NOT cause waitForReady to resolve.
      stdoutTrailingLines: [
        JSON.stringify({ type: 'log', msg: 'still loading skills' }),
        JSON.stringify({ type: 'log', msg: 'mcp apply' }),
      ],
    });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: true });
  });

  it('still resolves when ready arrives via stdout (legacy path)', async () => {
    const deps = createMockDeps({
      sessionState: SessionState.IDLE,
      readyChannel: 'stdout',
    });
    const router = new InteragentRouter(deps);
    const result = await router.handleInvoke(createParams());
    expect(result).toEqual({ ok: true });
  });

  it('rejects with diagnostic context (last stdout) when neither channel emits ready', async () => {
    const deps = createMockDeps({
      sessionState: SessionState.IDLE,
      readyChannel: 'none',
    });
    const router = new InteragentRouter(deps);

    const privateRouter = router as unknown as {
      waitForReady: (sid: string, ms?: number) => Promise<void>;
    };
    const fakeChild = deps.workerManager.getWorker('B') as EventEmitter & { stdout: EventEmitter };

    // Start waitForReady FIRST so the 'data' listener is attached before
    // we emit log noise onto stdout.
    const readyPromise = privateRouter.waitForReady('B', 50);

    // Yield a microtask so the synchronous listener-attach in waitForReady
    // completes before we start emitting.
    await Promise.resolve();
    fakeChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'log', msg: 'still loading skills' }) + '\n'),
    );
    fakeChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'log', msg: 'conductor subsystem register' }) + '\n'),
    );

    let directError: Error | undefined;
    await readyPromise.catch((e: unknown) => {
      directError = e as Error;
    });

    expect(directError).toBeInstanceOf(Error);
    expect(directError!.message).toMatch(/interagent target ready timeout/);
    expect(directError!.message).toMatch(/last stdout:/);
    expect(directError!.message).toMatch(/still loading skills/);
  });
});

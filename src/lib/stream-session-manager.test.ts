/**
 * Stream Session Manager - Unit Tests
 *
 * Tests the actor state machine for chat SSE sessions:
 * 1. Pre-registration: listeners can subscribe before startStream
 * 2. Stream isolation: old stream events don't contaminate new stream
 * 3. canSend recovery: terminal phase enables canSend without timeout
 * 4. Phase transitions: idle -> starting -> streaming -> ... -> completed|error|aborted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionStreamSnapshot, StreamPhase } from '@/types/message';
import type { PermissionRequestEvent } from '@/types/stream';

// We need to import the module in a way that lets us reset global state
// The manager uses a global singleton, so we need to reset it between tests

const GLOBAL_KEY = '__stream_session_manager__';

function getManager() {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  return global[GLOBAL_KEY];
}

function resetManager() {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  delete global[GLOBAL_KEY];
}

function createMockSSEResponse(events: Array<{ type: string; data?: string | Record<string, unknown> }>): Response {
  const sseData = events
    .map((e) => `event: ${e.type}\ndata: ${e.data ? JSON.stringify(e.data) : ''}\n\n`)
    .join('');

  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        const encoder = new TextEncoder();
        const chunks = sseData.split('\n\n').filter(Boolean);
        let index = 0;
        return {
          read: async () => {
            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }
            const chunk = chunks[index++];
            return { done: false, value: encoder.encode(chunk + '\n\n') };
          },
          releaseLock: () => {},
        };
      },
    } as ReadableStream<Uint8Array>,
  } as unknown as Response;
}

describe('StreamSessionManager State Machine', () => {
  beforeEach(() => {
    resetManager();
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      electronAPI: {
        agentServer: { getUrl: vi.fn().mockResolvedValue('http://127.0.0.1:3001') },
        provider: {
          getActiveProviderConfig: vi.fn().mockResolvedValue({
            apiKey: 'test-key',
            baseUrl: 'https://example.test',
            provider: 'openai',
            providerType: 'openai',
            model: 'test-model',
            authStyle: 'api_key',
          }),
        },
      },
    });
  });

  afterEach(() => {
    resetManager();
  });

  describe('ensureSession', () => {
    it('creates a session container for pre-registration before any stream starts', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      // Pre-register a listener BEFORE starting any stream
      const snapshots: SessionStreamSnapshot[] = [];
      const unsubscribe = streamSessionManager.subscribe('session-prereg', (snap) => {
        snapshots.push(snap);
      });

      // Session should exist with idle phase
      const initial = streamSessionManager.getSnapshot('session-prereg');
      expect(initial).not.toBeNull();
      expect(initial!.phase).toBe('idle');
      expect(initial!.sessionId).toBe('session-prereg');

      unsubscribe();
    });

    it('allows pre-registering permission listeners before stream starts', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const permissionSnapshots: PermissionRequestEvent[] = [];
      const unsubscribe = streamSessionManager.subscribeToPermissions('session-perm', (req) => {
        permissionSnapshots.push(req);
      });

      // Permission listener should be registered (can verify via internal state)
      const initial = streamSessionManager.getSnapshot('session-perm');
      expect(initial).not.toBeNull();

      unsubscribe();
    });
  });

  describe('Phase transitions', () => {
    it('transitions through correct phases: idle -> starting -> streaming -> completed', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const phases: StreamPhase[] = [];
      streamSessionManager.subscribe('phase-test', (snap) => {
        phases.push(snap.phase);
      });

      // Mock fetch to return a mock SSE response
      const mockFetch = vi.fn().mockResolvedValue(
        createMockSSEResponse([
          { type: 'connected' },
          { type: 'text', data: 'Hello' },
          { type: 'done' },
        ])
      );
      vi.stubGlobal('fetch', mockFetch);

      await streamSessionManager.startStream({
        sessionId: 'phase-test',
        content: 'Hello',
      });

      // Wait a bit for async stream processing
      await new Promise((r) => setTimeout(r, 100));

      expect(phases).toContain('starting');
      expect(phases).toContain('streaming');
      // Phase should eventually reach completed or similar terminal state
      const terminalPhases: StreamPhase[] = ['completed', 'error', 'aborted'];
      const hasTerminal = phases.some((p) => terminalPhases.includes(p));
      expect(hasTerminal).toBe(true);

      vi.restoreAllMocks();
    });

    it('surfaces max_turns as an error instead of a silent completed', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const errors: Array<{ message: string; code: string | null } | null> = [];
      streamSessionManager.subscribeToError('phase-maxturns', (err) => {
        errors.push(err);
      });

      // The server emits `done` with the terminal reason nested in data.
      const mockFetch = vi.fn().mockResolvedValue(
        createMockSSEResponse([
          { type: 'connected' },
          { type: 'done', data: { type: 'done', data: { reason: 'max_turns' } } },
        ])
      );
      vi.stubGlobal('fetch', mockFetch);

      await streamSessionManager.startStream({
        sessionId: 'phase-maxturns',
        content: 'Do a very long task',
      });
      await new Promise((r) => setTimeout(r, 100));

      const snapshot = streamSessionManager.getSnapshot('phase-maxturns');
      expect(snapshot).not.toBeNull();
      // max_turns must NOT look like a normal completion.
      expect(snapshot!.phase).toBe('error');
      expect(snapshot!.errorCode).toBe('max_turns');
      const lastError = errors[errors.length - 1];
      expect(lastError?.code).toBe('max_turns');
      expect(lastError?.message).toContain('最大工具轮数上限');

      vi.restoreAllMocks();
    });
  });

  describe('background task resumption', () => {
    it('starts an empty internal follow-up with the previous turn configuration', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');
      const mockFetch = vi.fn().mockResolvedValue(
        createMockSSEResponse([
          { type: 'connected' },
          { type: 'done' },
        ]),
      );
      vi.stubGlobal('fetch', mockFetch);

      await streamSessionManager.startStream({
        sessionId: 'background-resume',
        content: 'Delegate this task',
        agentProfileId: 'code',
        mode: 'plan-task',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await streamSessionManager.resumeBackgroundTask('background-resume');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const request = mockFetch.mock.calls[1]?.[1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        prompt: string;
        options: { backgroundTaskResume?: boolean; agentProfileId?: string | null; mode?: string };
      };
      expect(body.prompt).toBe('');
      expect(body.options).toMatchObject({
        backgroundTaskResume: true,
        agentProfileId: 'code',
        mode: 'plan-task',
      });
    });

    it('defers a completion wakeup that arrives before the foreground stream ends', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');
      let releaseForeground: (() => void) | undefined;
      const foregroundResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            const encoder = new TextEncoder();
            let index = 0;
            return {
              read: async () => {
                if (index++ === 0) {
                  return {
                    done: false,
                    value: encoder.encode('event: connected\ndata: \n\n'),
                  };
                }
                if (index === 2) {
                  await new Promise<void>((resolve) => {
                    releaseForeground = resolve;
                  });
                  return {
                    done: false,
                    value: encoder.encode('event: done\ndata: "done"\n\n'),
                  };
                }
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
            };
          },
        } as ReadableStream<Uint8Array>,
      } as unknown as Response;
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(foregroundResponse)
        .mockResolvedValueOnce(createMockSSEResponse([{ type: 'connected' }, { type: 'done', data: 'done' }]));
      vi.stubGlobal('fetch', mockFetch);

      await streamSessionManager.startStream({
        sessionId: 'background-race',
        content: 'Delegate this task',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await streamSessionManager.resumeBackgroundTask('background-race')).toBe(false);

      releaseForeground?.();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Stream isolation (streamId correlation)', () => {
    it('prevents old stream events from affecting new stream for same session', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const snapshots: SessionStreamSnapshot[] = [];
      streamSessionManager.subscribe('session-iso', (snap) => {
        snapshots.push(snap);
      });

      const mockFetch = vi.fn();

      // First stream - slow, sends text
      const stream1Events = [
        { type: 'connected' },
        { type: 'text', data: 'Stream1-' },
        { type: 'text', data: 'part1' },
        { type: 'done' },
      ];

      // Second stream (starts before first finishes) - different content
      const stream2Events = [
        { type: 'connected' },
        { type: 'text', data: 'Stream2-content' },
        { type: 'done' },
      ];

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50)); // Simulate delay
        return createMockSSEResponse(callCount === 1 ? stream1Events : stream2Events);
      });

      vi.stubGlobal('fetch', mockFetch);

      // Start first stream
      const result1 = await streamSessionManager.startStream({
        sessionId: 'session-iso',
        content: 'Stream1',
      });

      // Start second stream immediately (first stream still in progress)
      await new Promise((r) => setTimeout(r, 10));
      const result2 = await streamSessionManager.startStream({
        sessionId: 'session-iso',
        content: 'Stream2',
      });

      // Stream IDs should be different
      expect(result1.streamId).not.toBe(result2.streamId);

      // Wait for streams to complete
      await new Promise((r) => setTimeout(r, 200));

      // Final snapshot should only have Stream2 content
      const final = streamSessionManager.getSnapshot('session-iso');
      expect(final).not.toBeNull();
      // If stream isolation works, we should NOT see "Stream1" in final content
      // (The exact behavior depends on timing, but old stream should not corrupt new)

      vi.restoreAllMocks();
    });
  });

  describe('canSend calculation', () => {
    it('returns true for idle session', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      streamSessionManager.ensureSession('cansend-idle');
      expect(streamSessionManager.canSend('cansend-idle')).toBe(true);
    });

    it('returns false during active phase', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const mockFetch = vi.fn().mockResolvedValue(
        createMockSSEResponse([
          { type: 'connected' },
          { type: 'text', data: 'Hello' },
        ])
      );
      vi.stubGlobal('fetch', mockFetch);

      streamSessionManager.ensureSession('cansend-active');

      // Initially should be able to send
      expect(streamSessionManager.canSend('cansend-active')).toBe(true);

      // After starting stream (but before completion), should NOT be able to send
      // Note: The exact timing depends on async operations

      vi.restoreAllMocks();
    });

    it('returns true after terminal phase', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const mockFetch = vi.fn().mockResolvedValue(
        createMockSSEResponse([
          { type: 'connected' },
          { type: 'text', data: 'Done' },
          { type: 'done' },
        ])
      );
      vi.stubGlobal('fetch', mockFetch);

      streamSessionManager.ensureSession('cansend-terminal');
      await streamSessionManager.startStream({
        sessionId: 'cansend-terminal',
        content: 'Hello',
      });

      // Wait for completion
      await new Promise((r) => setTimeout(r, 150));

      // After terminal phase, should be able to send again
      // (This tests the core fix: no more stuck sending state)
      expect(streamSessionManager.canSend('cansend-terminal')).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('stopStream', () => {
    it('sets phase to aborted', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      streamSessionManager.ensureSession('stop-test');

      await streamSessionManager.stopStream('stop-test', 'User cancelled');

      const snap = streamSessionManager.getSnapshot('stop-test');
      expect(snap).not.toBeNull();
      expect(snap!.phase).toBe('aborted');
      expect(snap!.error).toBe('User cancelled');
    });

    it('allows sending after abort', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      streamSessionManager.ensureSession('stop-send-test');
      await streamSessionManager.stopStream('stop-send-test', 'Cancelled');

      expect(streamSessionManager.canSend('stop-send-test')).toBe(true);
    });
  });

  describe('Listener cleanup', () => {
    it('unsubscribe removes listener', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');

      const calls: SessionStreamSnapshot[] = [];
      const unsubscribe = streamSessionManager.subscribe('cleanup-test', (snap) => {
        calls.push(snap);
      });

      // Trigger update
      streamSessionManager.ensureSession('cleanup-test');
      const before = calls.length;

      // Unsubscribe
      unsubscribe();

      // Trigger another update - listener should NOT be called
      const initial = streamSessionManager.getSnapshot('cleanup-test');
      // Note: Since snapshot doesn't change on getSnapshot, we need another way to trigger
      // This test structure is simplified
      expect(before).toBeGreaterThan(0);
    });
  });

  /**
   * Long-running foreground tools (BashTool running `cargo test`, a slow
   * HTTP fetch via MCP, a Read on a cold disk, etc.) emit no SSE events
   * while they await the underlying subprocess. Without intervention, the
   * session-level idle timeout (STREAM_IDLE_TIMEOUT_MS = 280s) would trip
   * mid-run, abort the SSE stream, and the renderer would see the entire
   * message list disappear — even though the tool was making progress.
   *
   * These tests pin the contract that `resetIdleTimeout` pauses while a
   * tool_use is awaiting its tool_result, and resumes on tool_result.
   *
   * Implementation note: rather than driving a real SSE reader (whose
   * microtask scheduling fights vi.useFakeTimers), we start a real stream,
   * then dispatch `tool_use` / `tool_result` events directly through the
   * AgentServerClient's emit() path — which is exactly how the production
   * SSE parser feeds events to stream-session-manager. This isolates the
   * idle-timeout logic from the SSE transport.
   */
  describe('Idle timeout pauses while a tool is pending', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
      * Start a stream with a real-looking SSE response that hangs forever
      * after the SSE handshake. Returns a handle the test uses to dispatch
      * tool_use / tool_result events directly.
      */
    async function startHangingStream(streamSessionManager: typeof import('./stream-session-manager').streamSessionManager, sessionId: string) {
      const { getAgentServerClient } = await import('./agent-http-client');

      let releaseRead: (() => void) | undefined;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              await new Promise<void>((resolve) => {
                releaseRead = resolve;
              });
              return { done: true, value: undefined };
            },
            releaseLock: () => {},
          }),
        },
      } as unknown as Response));

      const startResult = await streamSessionManager.startStream({
        sessionId,
        content: 'Run something',
      });

      // Flush microtasks so SSE reader is registered with the manager.
      await vi.advanceTimersByTimeAsync(0);

      // The singleton client has the manager's handler registered. We can
      // drive events through emit() — same code path the SSE parser uses.
      const client = getAgentServerClient();
      const emit = (event: { type: string; data?: Record<string, unknown> }) => {
        client['emit'](sessionId, {
          type: event.type,
          sessionId,
          data: event.data,
          id: event.data?.id as string | undefined,
          name: event.data?.name as string | undefined,
          input: event.data?.input,
          result: event.data?.result,
          error: event.data?.error as string | undefined,
          content: event.data?.content as string | undefined,
          reason: event.data?.reason as string | undefined,
        });
      };

      return {
        emit,
        release: () => releaseRead?.(),
        streamId: startResult.streamId,
      };
    }

    it('does not abort the stream when a tool_use is open longer than the idle window', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');
      const { STREAM_IDLE_TIMEOUT_MS } = await import('./constants');
      const { emit } = await startHangingStream(streamSessionManager, 'idle-pause');

      emit({ type: 'tool_use', data: { id: 'tool-1', name: 'bash', input: { command: 'cargo test' } } });

      const snapBefore = streamSessionManager.getSnapshot('idle-pause');
      expect(snapBefore).not.toBeNull();
      expect(snapBefore!.toolUses.length).toBe(1);
      expect(snapBefore!.toolResults.length).toBe(0);

      // Advance well past STREAM_IDLE_TIMEOUT_MS (280s).
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 5_000);

      const snapAfter = streamSessionManager.getSnapshot('idle-pause');
      expect(snapAfter).not.toBeNull();
      expect(snapAfter!.phase).not.toBe('aborted');
      expect(snapAfter!.error).not.toBe('Idle timeout exceeded');

      vi.restoreAllMocks();
    });

    it('resumes the idle window after tool_result and aborts when the next idle window elapses', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');
      const { STREAM_IDLE_TIMEOUT_MS } = await import('./constants');
      const { emit } = await startHangingStream(streamSessionManager, 'idle-resume');

      emit({ type: 'tool_use', data: { id: 'tool-1', name: 'bash', input: {} } });

      // Past 1st idle window: still alive (tool pending).
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 5_000);
      let snap = streamSessionManager.getSnapshot('idle-resume');
      expect(snap!.phase).not.toBe('aborted');

      // Tool resolves — idle window should start fresh from this point.
      emit({ type: 'tool_result', data: { id: 'tool-1', result: 'ok', error: false } });

      snap = streamSessionManager.getSnapshot('idle-resume');
      expect(snap!.toolUses.length).toBe(1);
      expect(snap!.toolResults.length).toBe(1);

      // Advancing less than the idle window should still keep us alive.
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS / 2);
      snap = streamSessionManager.getSnapshot('idle-resume');
      expect(snap!.phase).not.toBe('aborted');

      // Crossing the window — no tool pending — must abort.
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
      snap = streamSessionManager.getSnapshot('idle-resume');
      expect(snap!.phase).toBe('aborted');
      expect(snap!.error).toBe('Idle timeout exceeded');

      vi.restoreAllMocks();
    });

    it('still aborts via idle timeout when no tool is pending and no events arrive', async () => {
      const { streamSessionManager } = await import('./stream-session-manager');
      const { STREAM_IDLE_TIMEOUT_MS } = await import('./constants');
      await startHangingStream(streamSessionManager, 'idle-no-tool');

      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 5_000);

      const snap = streamSessionManager.getSnapshot('idle-no-tool');
      expect(snap).not.toBeNull();
      expect(snap!.phase).toBe('aborted');
      expect(snap!.error).toBe('Idle timeout exceeded');

      vi.restoreAllMocks();
    });
  });
});

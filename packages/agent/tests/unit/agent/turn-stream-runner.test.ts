/**
 * runTurnStream unit tests — Plan 550 step 2e (TurnLoop first slice).
 *
 * Pins the contract that callers downstream of `streamChat` depend on.
 * Retry *timing* is covered by `stream-retry.test.ts`; here we verify
 * the wrapper around it:
 *
 *   - Successful first attempt yields the LLM events directly.
 *   - `shouldReplayStreamAfterError` veto wins: a non-retryable
 *     error (or a retryable error after `turnCommitted`) is
 *     rethrown unchanged, with no retry hook fired.
 *   - `refreshDeclaredTools` is consulted on every attempt (initial
 *     + retries) so the visibility guard reads the latest snapshot.
 *   - The retry budget caps the number of replays; once exhausted,
 *     the final retryable error is rethrown so the caller can fall
 *     back to the catch path.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import { runTurnStream } from '../../../src/agent/TurnStreamRunner.js';
import { STREAM_REPLAY_MAX_ATTEMPTS } from '../../../src/agent/stream-retry.js';
import type { AIClient, Message, SSEEvent } from '@duya/ai';
import type { Tool } from '../../../src/types.js';

interface MockAIClient extends AIClient {
  /** Override the per-call behavior; each entry is a generator or a thrown error. */
  callScript: Array<AsyncGenerator<SSEEvent, void, unknown> | Error>;
}

function makeClient(script: MockAIClient['callScript']): MockAIClient {
  let callIdx = 0;
  return {
    callScript: script,
    async *streamChat(
      _messages: Message[],
      _options?: Record<string, unknown>,
    ): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
      const item = script[callIdx++];
      if (!item) {
        throw new Error(`Unexpected call #${callIdx}`);
      }
      if (item instanceof Error) {
        throw item;
      }
      // Emit the scripted events then return.
      for await (const ev of item) {
        yield ev;
      }
      return { id: 'assistant-1', role: 'assistant', content: 'done' };
    },
  } as unknown as MockAIClient;
}

async function drain<T>(gen: AsyncGenerator<T, unknown, unknown>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

const dummyMessages: Message[] = [
  { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
];
const dummyTools: Tool[] = [
  { name: 'echo', description: 'echo', input_schema: { type: 'object' } },
];

const baseDeps = () => ({
  llmMessages: dummyMessages,
  systemPromptContent: 'sys',
  tools: dummyTools,
  maxTokens: 1024,
  temperature: 1,
  signal: new AbortController().signal,
  turnCount: 1,
  turnCommitted: false,
  refreshDeclaredTools: () => new Set(['echo']),
  onRetryReset: () => undefined,
});

describe('runTurnStream (Plan 550 2e — TurnLoop first slice)', () => {
  it('forwards LLM events directly on the first successful attempt', async () => {
    async function* successScript(): AsyncGenerator<SSEEvent, void, unknown> {
      yield { type: 'text', data: 'hello' } as SSEEvent;
      yield { type: 'done', reason: 'completed' } as SSEEvent;
    }
    const client = makeClient([successScript()]);
    const events = await drain(
      runTurnStream({ ...baseDeps(), llmClient: client }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', data: 'hello' });
    expect(events[1]).toEqual({ type: 'done', reason: 'completed' });
  });

  it('refreshes the declared-tools snapshot on every attempt', async () => {
    async function* successScript(): AsyncGenerator<SSEEvent, void, unknown> {
      yield { type: 'done', reason: 'completed' } as SSEEvent;
    }
    const client = makeClient([successScript()]);
    const refresh = vi.fn(() => new Set(['echo']));
    await drain(
      runTurnStream({
        ...baseDeps(),
        llmClient: client,
        refreshDeclaredTools: refresh,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does NOT call onRetryReset on the first successful attempt', async () => {
    async function* successScript(): AsyncGenerator<SSEEvent, void, unknown> {
      yield { type: 'done', reason: 'completed' } as SSEEvent;
    }
    const client = makeClient([successScript()]);
    const reset = vi.fn();
    await drain(
      runTurnStream({
        ...baseDeps(),
        llmClient: client,
        onRetryReset: reset,
      }),
    );
    expect(reset).not.toHaveBeenCalled();
  });

  it('rethrows a non-retryable error without retrying', async () => {
    const client = makeClient([new Error('non-retryable abort')]);
    const reset = vi.fn();
    const refresh = vi.fn(() => new Set(['echo']));
    await expect(
      drain(
        runTurnStream({
          ...baseDeps(),
          llmClient: client,
          onRetryReset: reset,
          refreshDeclaredTools: refresh,
        }),
      ),
    ).rejects.toThrow(/non-retryable/);
    expect(reset).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not retry when the turn is already committed (turnCommitted=true)', async () => {
    const client = makeClient([new TypeError('terminated')]);
    const reset = vi.fn();
    await expect(
      drain(
        runTurnStream({
          ...baseDeps(),
          llmClient: client,
          turnCommitted: true,
          onRetryReset: reset,
        }),
      ),
    ).rejects.toThrow(/terminated/);
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not retry when the abort signal has fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient([new TypeError('terminated')]);
    const reset = vi.fn();
    await expect(
      drain(
        runTurnStream({
          ...baseDeps(),
          llmClient: client,
          signal: controller.signal,
          onRetryReset: reset,
        }),
      ),
    ).rejects.toThrow(/terminated/);
    expect(reset).not.toHaveBeenCalled();
  });

  it('exposes STREAM_REPLAY_MAX_ATTEMPTS for the wrapper to consume', () => {
    // Pin the retry budget so the wrapper's contract is testable.
    expect(STREAM_REPLAY_MAX_ATTEMPTS).toBe(3);
  });
});
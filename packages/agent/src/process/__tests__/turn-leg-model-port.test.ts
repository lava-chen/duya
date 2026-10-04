/**
 * `createTurnLegModelPort` — the model port bound to a run's published leg.
 *
 * ## The claim under test
 *
 * `createLegacyModelPort` calls `llmClient.streamChat` directly. That is fine
 * for a caller that owns the client, and wrong for the worker entry, which
 * owns neither: the client and the request live inside `DuyaAgent.streamChat`'s
 * closure, and calling the client directly would drop `runTurnStream`'s replay
 * envelope — the layer whose `onRetryReset` discards the turn's `executor` and
 * clears the per-attempt accumulators after a transport death.
 *
 * So the assertion that matters here is not "frames come out". It is that a
 * transport death REPLAYS through this port. The test below scripts a client
 * that dies on its first call: a port that bypassed `runTurnStream` would make
 * one call and rethrow, so `client.seen.length` and the absence of a throw are
 * both load-bearing.
 *
 * The narrowing is inherited from `toModelFrame` and is covered in
 * `run-engine-model-frames.test.ts`; what is pinned here is that this adapter
 * uses it, which shows up as the retry chip (`type: 'system'`) being filtered
 * out while the replayed attempt's frames are not.
 */

import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '@duya/ai';
import type { ModelRequest } from '@duya/agent-runtime';
import { createTurnLegModelPort } from '../run-engine-model.js';
import { ModelLegPublisher, buildTurnModelLeg } from '../../agent/model-leg.js';
import type { TurnStreamRunnerDeps } from '../../agent/TurnStreamRunner.js';

const REQUEST: ModelRequest = {
  systemPrompt: 'you are duya',
  messages: [{ role: 'user', content: 'hi', id: 'm1' }],
  tools: [],
};

/** A client that dies on every ODD call and otherwise completes the turn. */
function dyingClient() {
  const seen: string[] = [];
  let n = 0;
  return {
    seen,
    async *streamChat(): AsyncGenerator<SSEEvent, unknown, unknown> {
      seen.push(`call-${(n += 1)}`);
      if (n % 2 === 1) throw new TypeError('terminated');
      yield { type: 'text', data: 'replayed' } as SSEEvent;
      yield { type: 'done', reason: 'end_turn' } as SSEEvent;
      return { id: 'a1', role: 'assistant', content: 'replayed' };
    },
  } as unknown as TurnStreamRunnerDeps['llmClient'];
}

function depsFor(client: TurnStreamRunnerDeps['llmClient']): TurnStreamRunnerDeps {
  return {
    llmClient: client,
    llmMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
    systemPromptContent: 'sys',
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
    maxTokens: 1024,
    temperature: 1,
    signal: new AbortController().signal,
    turnCount: 1,
    turnCommitted: false,
    refreshDeclaredTools: () => new Set(['Read']),
    onRetryReset: () => undefined,
  };
}

describe('createTurnLegModelPort', () => {
  it('replays a transport death instead of propagating it', async () => {
    const client = dyingClient();
    const publisher = new ModelLegPublisher();
    publisher.publish(buildTurnModelLeg({ turn: 1, deps: depsFor(client) }));

    const port = createTurnLegModelPort(publisher);
    const frames = [];
    // No `rejects` expectation: the whole point is that this does not throw.
    for await (const frame of port.stream(REQUEST, new AbortController().signal)) {
      frames.push(frame);
    }

    // Two calls: the initial attempt and its replay. One call, or a throw,
    // means the envelope was bypassed.
    expect((client as unknown as { seen: string[] }).seen).toEqual(['call-1', 'call-2']);
    // The retry chip is an SSE `system` event and is NOT a model frame, so it
    // is filtered by the narrowing; the replayed attempt's frames survive.
    expect(frames).toEqual([
      { type: 'text', text: 'replayed' },
      { type: 'turn_stopped', reason: 'end_turn' },
    ]);
  });

  it('refuses rather than yielding nothing when no turn has published', async () => {
    const publisher = new ModelLegPublisher();
    const port = createTurnLegModelPort(publisher);

    // An empty stream here would be indistinguishable from a model that chose
    // to produce nothing, which is the failure this seam exists to prevent.
    await expect(async () => {
      for await (const _ of port.stream(REQUEST, new AbortController().signal)) {
        /* unreachable */
      }
    }).rejects.toThrow(/no turn has published a model leg yet/);
  });

  it('refuses once the run has ended', async () => {
    const publisher = new ModelLegPublisher();
    publisher.publish(buildTurnModelLeg({ turn: 1, deps: depsFor(dyingClient()) }));
    publisher.close();

    const port = createTurnLegModelPort(publisher);
    await expect(async () => {
      for await (const _ of port.stream(REQUEST, new AbortController().signal)) {
        /* unreachable */
      }
    }).rejects.toThrow(/this run has ended/);
  });
});

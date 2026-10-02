/**
 * The translator and the projector, tested as one round trip.
 *
 * The property that matters is not "the mapping table looks right" — it is that
 * for every frame the product can produce, the frame the renderer sees after
 * the run layer is inserted is the frame it saw before. That is the whole basis
 * of the "no UI change" claim, so it is asserted as a round trip rather than
 * described in a comment.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { RunLedger } from '@duya/agent-protocol/testing';
import {
  classifyToolOutcome,
  projectToLegacyFrame,
  translateFrame,
  type TranslateContext,
} from '@duya/agent-runtime';

let turnCounter = 0;
const ctx: TranslateContext = {
  messageId: 'msg-1',
  permission: {
    classify: () => 'tool_use',
    mode: 'generic',
    expiresInMs: 300_000,
    now: () => 1_000,
  },
  nextTurn: () => {
    turnCounter += 1;
    return { turnId: `turn-${turnCounter}`, index: turnCounter };
  },
  model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
};

function ledger(): RunLedger {
  return new RunLedger({ runId: 'run-1', sessionId: 's-1', now: () => 0 });
}

function roundTrip(raw: Record<string, unknown>): { event: RunEvent; frame: ReturnType<typeof projectToLegacyFrame> } {
  const translated = translateFrame(raw, ctx);
  if (!translated.ok) throw new Error(`expected a translation, got ${translated.reason}`);
  const envelope: RunEventEnvelope = {
    runId: 'run-1',
    sessionId: 's-1',
    seq: 1,
    timestamp: 0,
    traceId: 't',
    payload: translated.event,
  };
  return { event: translated.event, frame: projectToLegacyFrame(envelope) };
}

describe('translateFrame — the producer vocabulary', () => {
  it('maps a normalised text frame to a durable text block', () => {
    const { event } = roundTrip({ type: 'text', data: { content: 'hello' } });
    expect(event).toMatchObject({ type: 'assistant.text_block', text: 'hello' });
  });

  it('reads a bare-string data as well as a nested object', () => {
    // `chat:text` carries a bare string; `compact:*` carries an object. Both
    // exist on the wire, so both are read.
    const { event } = roundTrip({ type: 'text', data: 'bare' });
    expect(event).toMatchObject({ type: 'assistant.text_block', text: 'bare' });
  });

  it('accepts the raw chat: spelling as well as the normalised one', () => {
    // The translator can sit either side of the router's normalisation, so
    // both spellings resolve to the same protocol event.
    const { event } = roundTrip({ type: 'chat:text', content: 'x' });
    expect(event).toMatchObject({ type: 'assistant.text_block', text: 'x' });
  });

  it('separates tool preview from the authoritative start', () => {
    // One slot, two durabilities. The preview is volatile and the start is
    // durable; collapsing them is the mistake the protocol split exists for.
    const preview = roundTrip({ type: 'tool_use_started', data: { id: 't1', name: 'Read', input: { path: 'a' } } });
    const start = roundTrip({ type: 'tool_use', data: { id: 't1', name: 'Read', input: { path: 'a' } } });
    expect(preview.event.type).toBe('tool.call_preview');
    expect(start.event.type).toBe('tool.call_started');
  });

  it('maps a tool result and classifies a missing error flag as indeterminate', () => {
    const { event } = roundTrip({ type: 'tool_result', data: { id: 't1', result: 'ok' } });
    expect(event).toMatchObject({ type: 'tool.call_completed', content: 'ok' });
    if (event.type !== 'tool.call_completed') throw new Error('unreachable');
    expect(event.outcome.outcome).toBe('indeterminate');
  });

  it('preserves an explicit error flag as a tool_error outcome', () => {
    const { event } = roundTrip({ type: 'tool_result', data: { id: 't1', result: 'boom', error: true } });
    if (event.type !== 'tool.call_completed') throw new Error('unreachable');
    expect(event.outcome.outcome).toBe('tool_error');
  });

  it('drops an unmapped permission request rather than inventing a kind', () => {
    // No requestId means no honest protocol form. G-2: a derived kind is a
    // guess that then reads as a fact in a durable audit chain.
    const result = translateFrame({ type: 'permission', data: { toolName: 'Bash' } }, ctx);
    expect(result.ok).toBe(false);
  });

  it('supplies kind, mode and expiry for a permission request that has an id', () => {
    // These are the three producer facts the protocol's reference adapter
    // refuses to synthesise. The runtime is the layer that can supply them.
    const { event } = roundTrip({ type: 'permission', data: { requestId: 'p1', toolName: 'Bash' } });
    expect(event).toMatchObject({
      type: 'permission.requested',
      requestId: 'p1',
      kind: 'tool_use',
      mode: 'generic',
      startedAt: 1_000,
      expiresAt: 301_000,
    });
  });

  it('maps usage only when there is numeric evidence of tokens', () => {
    // A zero-usage event would be a fabricated accounting entry.
    const withUsage = translateFrame({ type: 'token_usage', data: { input_tokens: 5, output_tokens: 7 } }, ctx);
    expect(withUsage.ok).toBe(true);
    const without = translateFrame({ type: 'token_usage', data: {} }, ctx);
    expect(without.ok).toBe(false);
  });

  it('drops the internal heartbeat rather than modelling it', () => {
    // A heartbeat leaking into a transcript is the kind of thing only noticed
    // months later.
    for (const type of ['pong', 'memory:wakeup']) {
      const result = translateFrame({ type }, ctx);
      expect(result).toMatchObject({ ok: false, reason: 'internal' });
    }
  });

  it('leaves done with no stop reason rather than inventing one', () => {
    // The worker sends no fields on `done`. A plausible stop reason would be a
    // fabrication; the absence is the observation.
    const { event } = roundTrip({ type: 'done', data: {} });
    expect(event).toEqual({ type: 'run.completed', status: 'completed' });
  });

  it('splits agent_progress three ways on the worker own discriminator', () => {
    const started = roundTrip({ type: 'agent_progress', data: { agentEventType: 'subagent_started', subagentId: 's9', agentName: 'a' } });
    expect(started.event.type).toBe('subagent.started');

    const done = roundTrip({ type: 'agent_progress', data: { agentEventType: 'subagent_completed', subagentId: 's9' } });
    expect(done.event.type).toBe('subagent.completed');

    const hook = roundTrip({ type: 'agent_progress', data: { agentEventType: 'hook', hookName: 'PreToolUse', async: true } });
    expect(hook.event.type).toBe('hook.invoked');
  });

  it('classifies a producer error code without losing the original', () => {
    const { event } = roundTrip({ type: 'error', data: { message: 'nope', code: 'rate_limit_error' } });
    if (event.type !== 'run.failed') throw new Error('unreachable');
    expect(event.error.code).toBe('provider_rate_limited');
    expect(event.error.cause).toEqual({ system: 'provider', code: 'rate_limit_error' });
  });

  it('passes a code the producer already speaks through untouched', () => {
    const { event } = roundTrip({ type: 'error', data: { message: 'nope', code: 'provider_auth' } });
    if (event.type !== 'run.failed') throw new Error('unreachable');
    expect(event.error.code).toBe('provider_auth');
  });

  it('reports an unmodelled frame as unmapped rather than dropping it silently', () => {
    const result = translateFrame({ type: 'workflow_run', data: { run: { id: 'w1' } } }, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'unmapped' });
  });
});

describe('classifyToolOutcome', () => {
  it('is success only when the producer said so', () => {
    expect(classifyToolOutcome({ error: false }).outcome).toBe('success');
  });

  it('is tool_error when the producer said so', () => {
    expect(classifyToolOutcome({ error: true, result: 'boom' }).outcome).toBe('tool_error');
  });

  it('is indeterminate when the producer said nothing', () => {
    expect(classifyToolOutcome({}).outcome).toBe('indeterminate');
  });
});

describe('the round trip the renderer depends on', () => {
  it('reproduces the legacy frame the renderer parses for text', () => {
    const { frame } = roundTrip({ type: 'text', data: { content: 'hello' } });
    // `data.content`, not `data`. agent-http-client.ts:325-344 reads
    // `event.data.content`; a bare `data: 'hello'` renders as an empty message.
    expect(frame).toEqual({ type: 'text', data: { content: 'hello' } });
  });

  it('reproduces the legacy frame for a tool call', () => {
    const { frame } = roundTrip({ type: 'tool_use', data: { id: 't1', name: 'Read', input: { path: 'a' } } });
    expect(frame).toMatchObject({ type: 'tool_use', data: { id: 't1', name: 'Read', input: { path: 'a' } } });
  });

  it('reproduces the legacy frame for a tool result, including the error flag', () => {
    const ok = roundTrip({ type: 'tool_result', data: { id: 't1', result: 'r', error: false } });
    expect(ok.frame).toMatchObject({ type: 'tool_result', data: { id: 't1', result: 'r', error: false } });

    const bad = roundTrip({ type: 'tool_result', data: { id: 't1', result: 'r', error: true } });
    expect(bad.frame).toMatchObject({ type: 'tool_result', data: { error: true } });
  });

  it('omits the error flag entirely for an indeterminate tool result', () => {
    // The legacy union's flag is `error?: boolean` and cannot express
    // "unknown". Inventing `false` would report an unstated status as a
    // success, so the key is absent.
    const { frame } = roundTrip({ type: 'tool_result', data: { id: 't1', result: 'r' } });
    const data = frame?.data as Record<string, unknown>;
    expect('error' in data).toBe(false);
  });

  it('reproduces every modelled legacy type name', () => {
    // The exact set the renderer's switch handles. A rename here would be a
    // silent UI break, so the list is pinned.
    const frames: Array<[Record<string, unknown>, string]> = [
      [{ type: 'text', data: { content: 'x' } }, 'text'],
      [{ type: 'text_delta', data: { content: 'x' } }, 'text_delta'],
      [{ type: 'thinking', data: { content: 'x' } }, 'thinking'],
      [{ type: 'thinking_delta', data: { content: 'x' } }, 'thinking_delta'],
      [{ type: 'tool_use_started', data: { id: 't', name: 'R', input: {} } }, 'tool_use_started'],
      [{ type: 'tool_use_delta', data: { id: 't', delta: '{' } }, 'tool_use_delta'],
      [{ type: 'tool_use', data: { id: 't', name: 'R', input: {} } }, 'tool_use'],
      [{ type: 'tool_result', data: { id: 't', result: 'r' } }, 'tool_result'],
      [{ type: 'tool_progress', data: { id: 't', elapsed_ms: 1500 } }, 'tool_progress'],
      [{ type: 'tool_group_progress', data: { groupId: 'g', title: 'x', source: 's' } }, 'tool_group_progress'],
      [{ type: 'permission', data: { requestId: 'p', toolName: 'Bash' } }, 'permission'],
      [{ type: 'turn_start', data: { turnCount: 1 } }, 'turn_start'],
      [{ type: 'token_usage', data: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }, 'token_usage'],
      [{ type: 'status', data: { message: 'working' } }, 'status'],
      [{ type: 'retry', data: { attempt: 1, maxAttempts: 3, delayMs: 100, message: 'retrying' } }, 'retry'],
      [{ type: 'mode_changed', data: { mode: 'plan', source: 'agent' } }, 'mode_changed'],
      [{ type: 'goal_updated', data: { state: 'active', phase: 'run', objective: 'o' } }, 'goal_updated'],
      [{ type: 'compact:start', data: {} }, 'compact:start'],
      [{ type: 'compact:done', data: { removedCount: 2 } }, 'compact:done'],
      [{ type: 'compact:error', data: { message: 'x' } }, 'compact:error'],
      [{ type: 'compact:step', data: { phase: 'cutting' } }, 'compact:step'],
      [{ type: 'compact:over_threshold', data: { tokensRetained: 10, available: 5 } }, 'compact:over_threshold'],
      [{ type: 'agent_progress', data: { hookName: 'h', async: false } }, 'agent_progress'],
      [{ type: 'done', data: {} }, 'done'],
      [{ type: 'error', data: { message: 'x' } }, 'error'],
    ];
    for (const [raw, expected] of frames) {
      const { frame } = roundTrip(raw);
      expect(frame?.type, `frame for ${raw.type}`).toBe(expected);
    }
  });

  it('projects run.started to nothing, because the UI has no frame for it', () => {
    // The manifest hash lives in `run_events` and nowhere the renderer sees.
    const envelope: RunEventEnvelope = {
      runId: 'r',
      sessionId: 's',
      seq: 1,
      timestamp: 0,
      traceId: 't',
      payload: {
        type: 'run.started',
        manifestHash: 'h',
        protocol: { major: 1, minor: 0 },
        runtime: { name: 'x', version: '1' },
      },
    };
    expect(projectToLegacyFrame(envelope)).toBeNull();
  });

  it('projects every event with no legacy counterpart to null', () => {
    const envelopes: RunEventEnvelope[] = [
      { runId: 'r', sessionId: 's', seq: 1, timestamp: 0, traceId: 't', payload: { type: 'run.paused', at: 'any' } },
      { runId: 'r', sessionId: 's', seq: 2, timestamp: 0, traceId: 't', payload: { type: 'permission.resolved', requestId: 'p', action: 'allow', source: 'host', latencyMs: 1 } },
      { runId: 'r', sessionId: 's', seq: 3, timestamp: 0, traceId: 't', payload: { type: 'checkpoint.saved', checkpointRef: 'c', generation: 1, eventSeq: 2 } },
      { runId: 'r', sessionId: 's', seq: 4, timestamp: 0, traceId: 't', payload: { type: 'diagnostic', level: 'info', message: 'm' } },
    ];
    for (const envelope of envelopes) {
      expect(projectToLegacyFrame(envelope), envelope.payload.type).toBeNull();
    }
  });
});

describe('the ledger contract the runtime inherits', () => {
  it('mints gapless run-scoped sequence numbers from 1', () => {
    const l = ledger();
    const first = l.emit({ type: 'turn.started', turnId: 't1', index: 1, model: 'm', providerId: 'p', apiFormat: 'anthropic' });
    const second = l.emit({ type: 'assistant.text_block', messageId: 'm', index: 0, text: 'x' });
    expect([first.seq, second.seq]).toEqual([1, 2]);
  });

  it('rejects an event after a terminal one', () => {
    const l = ledger();
    l.emit({ type: 'run.completed', status: 'completed' });
    expect(() => l.emit({ type: 'assistant.text_block', messageId: 'm', index: 0, text: 'late' })).toThrow();
  });

  it('rejects a tool result with no authoritative start', () => {
    const l = ledger();
    expect(() =>
      l.emit({ type: 'tool.call_completed', toolCallId: 'ghost', content: 'x', outcome: { outcome: 'success' }, durationMs: 1 }),
    ).toThrow();
  });
});

/**
 * Budget accounting and durability policy.
 *
 * The two suites live together because they are the two ways a run answers
 * "what happened" and "what did it cost", and the interesting cases are the
 * ones where the cheap answer is wrong: a turn that started and never
 * completed, and an ephemeral storm that must not be stored.
 */

import { describe, expect, it } from 'vitest';
import type { RunBudget, TokenUsage } from '@duya/agent-protocol';
import { EVENT_REGISTRY } from '@duya/agent-protocol';
import {
  countEvent,
  dispositionOf,
  dispositionTable,
  durableOnly,
  emptyCounters,
  isBudgetExhausted,
  isRetainable,
  remainingBudget,
  totalSpend,
  type SpendEvent,
} from '@duya/agent-core';

const usage = (totalTokens: number): TokenUsage => ({
  inputTokens: Math.floor(totalTokens / 2),
  outputTokens: totalTokens - Math.floor(totalTokens / 2),
  totalTokens,
});

describe('totalSpend', () => {
  it('counts a started turn, not a completed one', () => {
    // A turn that started and died mid-flight still consumed budget. Waiting
    // for turn.completed would make a crashed turn free.
    const spend = totalSpend([{ type: 'turn.started' }]);
    expect(spend.turns).toBe(1);
  });

  it('counts a dispatched tool call, not a returned one', () => {
    // `tool.call_started` is emitted before dispatch, which is what makes it
    // the honest count of side effects.
    const spend = totalSpend([{ type: 'tool.call_started' }, { type: 'tool.call_completed' } as SpendEvent]);
    expect(spend.toolCalls).toBe(1);
  });

  it('sums usage totals and ignores events without usage', () => {
    const spend = totalSpend([
      { type: 'assistant.usage', usage: usage(100) },
      { type: 'assistant.usage', usage: usage(50) },
      { type: 'assistant.text_block' } as SpendEvent,
    ]);
    expect(spend.tokens).toBe(150);
  });

  it('treats a missing usage object as zero rather than estimating', () => {
    // An invented token count is a number nobody can trace to a provider.
    expect(totalSpend([{ type: 'assistant.usage' }]).tokens).toBe(0);
  });

  it('falls back to input+output only when totalTokens is absent', () => {
    const spend = totalSpend([
      {
        type: 'assistant.usage',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: undefined as unknown as number },
      },
    ]);
    expect(spend.tokens).toBe(10);
  });

  it('is zero for an empty stream', () => {
    expect(totalSpend([])).toEqual({ turns: 0, toolCalls: 0, tokens: 0 });
  });
});

describe('isBudgetExhausted', () => {
  const budget: RunBudget = { maxTurns: 2, maxToolCalls: 3, maxTokens: 100 };

  it('reports no breach while under every ceiling', () => {
    const verdict = isBudgetExhausted(budget, { turns: 1, toolCalls: 1, tokens: 10 });
    expect(verdict.exhausted).toBe(false);
    expect(verdict.breaches).toEqual([]);
  });

  it('reports the breached ceiling, not just the fact', () => {
    const verdict = isBudgetExhausted(budget, { turns: 1, toolCalls: 5, tokens: 10 });
    expect(verdict.breaches).toEqual(['maxToolCalls']);
  });

  it('reports every ceiling crossed when more than one is', () => {
    // A run can cross two at once; naming only the first hides the second.
    const verdict = isBudgetExhausted(budget, { turns: 9, toolCalls: 9, tokens: 10 });
    expect(verdict.breaches).toEqual(['maxTurns', 'maxToolCalls']);
  });

  it('treats a zero ceiling as absent, not as stop-immediately', () => {
    // A budget assembled field-by-field from optional config yields 0 for
    // every unset number. Honouring that would refuse to run anything.
    const verdict = isBudgetExhausted({ maxTurns: 0, maxTokens: 0 }, { turns: 99, tokens: 99 });
    expect(verdict.exhausted).toBe(false);
  });

  it('evaluates the wall-clock ceiling only when a duration is known', () => {
    const withClock: RunBudget = { maxWallClockMs: 1000 };
    expect(isBudgetExhausted(withClock, { turns: 0, toolCalls: 0, tokens: 0 }).exhausted).toBe(false);
    expect(
      isBudgetExhausted(withClock, { turns: 0, toolCalls: 0, tokens: 0 }, 1500).breaches,
    ).toEqual(['maxWallClockMs']);
  });
});

describe('remainingBudget', () => {
  it('reports headroom and clamps at zero', () => {
    const remaining = remainingBudget({ maxTurns: 2, maxTokens: 10 }, { turns: 5, toolCalls: 0, tokens: 4 });
    expect(remaining.maxTurns).toBe(0);
    expect(remaining.maxTokens).toBe(6);
  });

  it('reports null for a ceiling that was never set', () => {
    expect(remainingBudget({}, { turns: 0, toolCalls: 0, tokens: 0 }).maxTurns).toBeNull();
  });
});

describe('dispositionOf', () => {
  it('retains durable events', () => {
    expect(dispositionOf('assistant.text_block')).toBe('retain');
    expect(isRetainable('tool.call_started')).toBe(true);
  });

  it('counts volatile events without retaining them', () => {
    // A tool preview describes a call that may never happen as stated.
    expect(dispositionOf('tool.call_preview')).toBe('count');
    expect(isRetainable('tool.call_preview')).toBe(false);
  });

  it('drops ephemeral events', () => {
    // The text block that follows already contains the deltas' bytes.
    expect(dispositionOf('assistant.text_delta')).toBe('drop');
  });

  it('drops an unregistered type rather than throwing', () => {
    // Forward compatibility: an old host meeting a new event type must not
    // crash the run, and an unknown event is never durable.
    expect(dispositionOf('some.future_event')).toBe('drop');
  });

  it('is total over the registry — every registered type has a disposition', () => {
    // This is the assertion that makes adding an EVENT_META entry a decision
    // rather than an accident: the mapping is derived, so a new event is
    // classified automatically and this test proves nothing fell through.
    const table = dispositionTable();
    expect(Object.keys(table).sort()).toEqual([...EVENT_REGISTRY.all].sort());
    for (const [type, disposition] of Object.entries(table)) {
      expect(['retain', 'count', 'drop'], `${type} has a disposition`).toContain(disposition);
    }
  });
});

describe('countEvent', () => {
  it('starts from zero', () => {
    expect(emptyCounters().total).toBe(0);
  });

  it('counts an ephemeral storm without growing any buffer', () => {
    let counters = emptyCounters();
    for (let i = 0; i < 5000; i += 1) {
      counters = countEvent(counters, { type: 'assistant.text_delta' });
    }
    expect(counters.ephemeral).toBe(5000);
    expect(counters.total).toBe(5000);
    expect(counters.durable).toBe(0);
  });

  it('counts total for an unknown type so the count reconciles against seq', () => {
    // An unrecognised frame still consumed a sequence number.
    const counters = countEvent(emptyCounters(), { type: 'mystery.event' });
    expect(counters.total).toBe(1);
    expect(counters.ephemeral).toBe(1);
  });

  it('tracks tool calls, turns and permission decisions separately', () => {
    let counters = emptyCounters();
    counters = countEvent(counters, { type: 'turn.started' });
    counters = countEvent(counters, { type: 'tool.call_started' });
    counters = countEvent(counters, { type: 'permission.requested' });
    counters = countEvent(counters, { type: 'permission.resolved' });
    expect(counters).toMatchObject({
      turns: 1,
      toolCalls: 1,
      permissionRequests: 1,
      permissionDecisions: 1,
      durable: 4,
    });
  });

  it('does not mutate the input counters', () => {
    const before = emptyCounters();
    countEvent(before, { type: 'turn.started' });
    expect(before.total).toBe(0);
  });
});

describe('durableOnly', () => {
  it('keeps durable events in order and drops the rest', () => {
    const kept = durableOnly([
      { type: 'run.started' },
      { type: 'assistant.text_delta' },
      { type: 'tool.call_preview' },
      { type: 'assistant.text_block' },
    ] as const);
    expect(kept.map((e) => e.type)).toEqual(['run.started', 'assistant.text_block']);
  });

  it('is empty when nothing durable has been emitted', () => {
    expect(durableOnly([{ type: 'assistant.text_delta' }])).toEqual([]);
  });
});

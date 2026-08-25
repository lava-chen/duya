/**
 * usage-aggregator.test.ts — pure-function tests for the usage dashboard
 * aggregation (db:usage:summary payload shape).
 *
 * Covers: cross-session totals, cache-bucket netting (both provider
 * conventions), pricing-backed cost + costEstimated flag, daily bucketing
 * with distinct session counts, heatmap cells, and message/tool/error
 * aggregates.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  aggregateUsageFromFacts,
  extractSessionFacts,
  UsageFactsCache,
  type UsageSessionInput,
  type UsagePricingLookup,
} from '../usage-aggregator';
import type { MessageRow } from '../core-db-adapters';

function msgRow(overrides: Partial<MessageRow> & { id: string }): MessageRow {
  return {
    id: overrides.id,
    session_id: overrides.session_id ?? 's1',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? '',
    display_content: null,
    name: null,
    tool_call_id: null,
    token_usage: overrides.token_usage ?? null,
    msg_type: overrides.msg_type ?? 'text',
    thinking: null,
    tool_name: overrides.tool_name ?? null,
    tool_input: null,
    parent_tool_call_id: null,
    viz_spec: null,
    status: overrides.status ?? 'done',
    seq_index: overrides.seq_index ?? 1,
    duration_ms: overrides.duration_ms ?? null,
    sub_agent_id: null,
    attachments: null,
    provider_state: null,
    thinking_signature: null,
    tool_signature: null,
    text_signature: null,
    created_at: overrides.created_at ?? new Date(2026, 7, 15, 10, 30).getTime(),
    ...overrides,
  };
}

function session(id: string, rows: MessageRow[], model = 'test-model'): UsageSessionInput {
  return {
    id,
    title: `Session ${id}`,
    model,
    providerId: 'prov',
    createdAt: new Date(2026, 7, 15, 10, 0).getTime(),
    updatedAt: new Date(2026, 7, 15, 11, 0).getTime(),
    rows,
  };
}

const PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

const pricedLookup: UsagePricingLookup = (_providerId, model) =>
  model === 'test-model' ? PRICING : undefined;

describe('aggregateUsage', () => {
  it('sums tokens across sessions and counts messages/tools/errors', () => {
    const ts = new Date(2026, 7, 15, 10, 30).getTime();
    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'u1', role: 'user', msg_type: 'text', created_at: ts }),
          msgRow({
            id: 'a1',
            role: 'assistant',
            token_usage: JSON.stringify({ input_tokens: 1000, output_tokens: 200 }),
            created_at: ts + 1000,
          }),
          msgRow({
            id: 'a2',
            role: 'assistant',
            msg_type: 'tool_use',
            tool_name: 'Bash',
            token_usage: JSON.stringify({ input_tokens: 1200, output_tokens: 50, total_tokens: 1300 }),
            created_at: ts + 2000,
            duration_ms: 1500,
          }),
          msgRow({ id: 't1', role: 'tool', msg_type: 'tool_result', tool_name: 'Bash', created_at: ts + 3000 }),
        ]),
        session('s2', [
          msgRow({
            id: 'a3',
            role: 'assistant',
            token_usage: JSON.stringify({ input_tokens: 500, output_tokens: 100 }),
            created_at: ts + 4000,
          }),
          msgRow({ id: 'a4', role: 'assistant', status: 'error', created_at: ts + 5000 }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.aggregates.sessionCount).toBe(2);
    expect(result.aggregates.messages.total).toBe(6);
    expect(result.aggregates.messages.user).toBe(1);
    expect(result.aggregates.messages.assistant).toBe(4);
    expect(result.aggregates.messages.toolCalls).toBe(1);
    expect(result.aggregates.messages.toolResults).toBe(1);
    expect(result.aggregates.messages.errors).toBe(1);
    expect(result.aggregates.tools.totalCalls).toBe(1);
    expect(result.aggregates.tools.uniqueTools).toBe(1);
    expect(result.aggregates.tools.tools[0]).toEqual({ name: 'Bash', count: 1 });
    expect(result.aggregates.durationSumMs).toBe(1500);

    // Volume is computed from the exclusive buckets + output so charts stay
    // additive; a provider-reported total_tokens that disagrees with its own
    // buckets (a2 reports 1300 vs 1200+50) is ignored.
    expect(result.totals.totalTokens).toBe((1000 + 200) + (1200 + 50) + (500 + 100));
    expect(result.totals.input).toBe(1000 + 1200 + 500);
    expect(result.totals.output).toBe(200 + 50 + 100);
  });

  it('nets cache out of input when input already includes cache (Anthropic convention)', () => {
    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({
            id: 'a1',
            token_usage: JSON.stringify({
              input_tokens: 1000, // includes 600 cacheRead + 100 cacheWrite
              output_tokens: 100,
              cache_hit_tokens: 600,
              cache_creation_tokens: 100,
            }),
          }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.totals.input).toBe(300);
    expect(result.totals.cacheRead).toBe(600);
    expect(result.totals.cacheWrite).toBe(100);

    // Volume is cache-inclusive: 300 fresh + 100 output + 600 read + 100
    // written — the full prompt volume the model actually processed.
    expect(result.totals.totalTokens).toBe(1100);

    // Cost bills each bucket exactly once.
    expect(result.totals.inputCost).toBeCloseTo((300 * 3) / 1_000_000, 9);
    expect(result.totals.outputCost).toBeCloseTo((100 * 15) / 1_000_000, 9);
    expect(result.totals.cacheReadCost).toBeCloseTo((600 * 0.3) / 1_000_000, 9);
    expect(result.totals.cacheWriteCost).toBeCloseTo((100 * 3.75) / 1_000_000, 9);
    expect(result.totals.costEstimated).toBe(false);
  });

  it('keeps input as-is when the gateway reports it excluding cache', () => {
    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({
            id: 'a1',
            token_usage: JSON.stringify({
              input_tokens: 200,
              output_tokens: 50,
              cache_hit_tokens: 600,
            }),
          }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.totals.input).toBe(200);
    expect(result.totals.cacheRead).toBe(600);

    // Cache-inclusive volume adds the cached portion back (the old
    // input+output semantics reported only 250 of 850 processed tokens).
    expect(result.totals.totalTokens).toBe(850);
  });

  it('marks costEstimated and zeroes cost when pricing is missing', () => {
    const result = aggregateUsage(
      [
        session('s1', [msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 100, output_tokens: 10 }) })], 'unknown-model'),
      ],
      pricedLookup,
    );

    expect(result.totals.totalTokens).toBe(110);
    expect(result.totals.totalCost).toBe(0);
    expect(result.totals.costEstimated).toBe(true);
  });

  it('buckets by local day and counts distinct sessions per day', () => {
    const day1 = new Date(2026, 7, 15, 10, 0).getTime();
    const day2 = new Date(2026, 7, 16, 22, 0).getTime();
    const usage = JSON.stringify({ input_tokens: 100, output_tokens: 10 });

    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: usage, created_at: day1 }),
          msgRow({ id: 'a2', token_usage: usage, created_at: day2 }),
        ]),
        session('s2', [
          msgRow({ id: 'a3', token_usage: usage, created_at: day1 }),
          msgRow({ id: 'a4', token_usage: usage, created_at: day1 }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.dailyData.map((d) => d.date)).toEqual(['2026-08-15', '2026-08-16']);
    const first = result.dailyData[0];
    expect(first.sessionCount).toBe(2);
    expect(first.messageCount).toBe(3);
    expect(first.tokens).toBe(330); // three usage-bearing messages
    expect(result.dailyData[1].sessionCount).toBe(1);
    expect(result.aggregates.activeDays).toBe(2);
  });

  it('aggregates daily tokens for a single day with multiple messages', () => {
    const ts = new Date(2026, 7, 15, 10, 0).getTime();

    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 100, output_tokens: 10 }), created_at: ts }),
          msgRow({ id: 'a2', token_usage: JSON.stringify({ input_tokens: 300, output_tokens: 30 }), created_at: ts }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.aggregates.activeDays).toBe(1);
    expect(result.dailyData[0].tokens).toBe(440);
  });

  it('skips sessions without messages', () => {
    const result = aggregateUsage([session('empty', [])], pricedLookup);
    expect(result.aggregates.sessionCount).toBe(0);
    expect(result.sessions).toHaveLength(0);
    expect(result.aggregates.activeDays).toBe(0);
  });

  it('sorts sessions by total tokens descending and builds per-session daily breakdown', () => {
    const day1 = new Date(2026, 7, 15, 10, 0).getTime();
    const day2 = new Date(2026, 7, 16, 10, 0).getTime();

    const result = aggregateUsage(
      [
        session('small', [
          msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 50, output_tokens: 5 }), created_at: day1 }),
        ]),
        session('big', [
          msgRow({ id: 'a2', token_usage: JSON.stringify({ input_tokens: 5000, output_tokens: 500 }), created_at: day1 }),
          msgRow({ id: 'a3', token_usage: JSON.stringify({ input_tokens: 1000, output_tokens: 100 }), created_at: day2 }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.sessions.map((s) => s.id)).toEqual(['big', 'small']);
    const big = result.sessions[0];
    expect(big.totalTokens).toBe(6600);
    expect(big.messageCount).toBe(2);
    expect(big.dailyBreakdown).toHaveLength(2);
    expect(big.dailyBreakdown[0].tokens).toBe(5500);
    expect(big.dailyBreakdown[0].cost).toBeCloseTo((5000 * 3 + 500 * 15) / 1_000_000, 9);
  });

  it('ignores malformed token_usage payloads', () => {
    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: '{not json' }),
          msgRow({ id: 'a2', token_usage: JSON.stringify({ input_tokens: 0, output_tokens: 0 }) }),
          msgRow({ id: 'a3', token_usage: JSON.stringify({ input_tokens: 10, output_tokens: 1 }) }),
        ]),
      ],
      pricedLookup,
    );

    expect(result.totals.totalTokens).toBe(11);
    expect(result.totals.costEstimated).toBe(false);
  });

  it('tracks per-model totals and daily model breakdown', () => {
    const day1 = new Date(2026, 7, 15, 10, 0).getTime();
    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 1000, output_tokens: 100 }), created_at: day1 }),
        ], 'model-a'),
        session('s2', [
          msgRow({ id: 'a2', token_usage: JSON.stringify({ input_tokens: 500, output_tokens: 50 }), created_at: day1 }),
          msgRow({ id: 'a3', token_usage: JSON.stringify({ input_tokens: 200, output_tokens: 20 }), created_at: day1 }),
        ], 'model-b'),
      ],
      pricedLookup,
    );

    expect(result.modelUsage).toHaveLength(2);
    expect(result.modelUsage[0].model).toBe('model-a');
    expect(result.modelUsage[0].tokens).toBe(1100);
    expect(result.modelUsage[0].percentage).toBeCloseTo(1100 / 1870, 9);
    expect(result.modelUsage[1].model).toBe('model-b');
    expect(result.modelUsage[1].tokens).toBe(770);

    const dayEntry = result.dailyData[0];
    expect(dayEntry.models['model-a']).toBe(1100);
    expect(dayEntry.models['model-b']).toBe(770);
  });

  it('computes current streak from active days', () => {
    const today = new Date(2026, 7, 17, 10, 0).getTime();
    const yesterday = new Date(2026, 7, 16, 10, 0).getTime();
    const twoDaysAgo = new Date(2026, 7, 15, 10, 0).getTime();

    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 10, output_tokens: 1 }), created_at: today }),
          msgRow({ id: 'a2', token_usage: JSON.stringify({ input_tokens: 10, output_tokens: 1 }), created_at: yesterday }),
          msgRow({ id: 'a3', token_usage: JSON.stringify({ input_tokens: 10, output_tokens: 1 }), created_at: twoDaysAgo }),
        ]),
      ],
      pricedLookup,
      today,
    );

    expect(result.aggregates.currentStreak).toBe(3);
  });

  it('resets streak when there is no activity today', () => {
    const today = new Date(2026, 7, 17, 10, 0).getTime();
    const yesterday = new Date(2026, 7, 16, 10, 0).getTime();

    const result = aggregateUsage(
      [
        session('s1', [
          msgRow({ id: 'a1', token_usage: JSON.stringify({ input_tokens: 10, output_tokens: 1 }), created_at: yesterday }),
        ]),
      ],
      pricedLookup,
      today,
    );

    expect(result.aggregates.currentStreak).toBe(0);
  });
});

describe('facts split + cache', () => {
  const cacheUsageRows = [
    msgRow({
      id: 'a1',
      token_usage: JSON.stringify({
        input_tokens: 1000,
        output_tokens: 100,
        cache_hit_tokens: 600,
        cache_creation_tokens: 100,
      }),
    }),
    msgRow({ id: 'u1', role: 'user', msg_type: 'text' }),
  ];

  it('aggregateUsageFromFacts matches the row-based compose exactly', () => {
    const s = session('s1', cacheUsageRows);
    const now = new Date(2026, 7, 15, 12, 0).getTime();
    const viaRows = aggregateUsage([s], pricedLookup, now);
    const viaFacts = aggregateUsageFromFacts(
      [{ ...s, facts: extractSessionFacts(s.rows) }],
      pricedLookup,
      now,
    );
    expect(viaFacts).toEqual(viaRows);
  });

  it('extractSessionFacts buckets usage exclusively and tracks per-date counts', () => {
    const facts = extractSessionFacts(cacheUsageRows);
    expect(facts.messageTotal).toBe(2);
    expect(facts.userCount).toBe(1);
    expect(facts.assistantCount).toBe(1);
    expect(facts.messagesPerDate).toHaveProperty('2026-08-15', 2);
    expect(facts.usageRows).toHaveLength(1);
    expect(facts.usageRows[0]).toEqual({
      date: '2026-08-15',
      input: 300,
      output: 100,
      cacheRead: 600,
      cacheWrite: 100,
      volume: 1100,
    });
  });

  it('UsageFactsCache reuses facts while the stamp is unchanged and prunes dead sessions', () => {
    const cache = new UsageFactsCache();
    const facts = extractSessionFacts(cacheUsageRows);

    cache.set('s1', '100:200', facts);
    expect(cache.get('s1', '100:200')).toBe(facts);
    // A different stamp (file changed) misses.
    expect(cache.get('s1', '101:200')).toBeUndefined();

    cache.set('s2', '1:1', facts);
    cache.prune(new Set(['s1']));
    expect(cache.get('s2', '1:1')).toBeUndefined();
    expect(cache.get('s1', '100:200')).toBe(facts);
  });
});

describe('cache health (plan 444)', () => {
  const t0 = new Date(2026, 7, 15, 10, 0).getTime();

  function usageRow(id: string, ts: number, u: Record<string, number>): MessageRow {
    return msgRow({ id, token_usage: JSON.stringify(u), created_at: ts });
  }

  it('extractSessionFacts builds an ordered cacheSequence with compaction markers', () => {
    const rows = [
      usageRow('a1', t0, { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 49_000 }),
      msgRow({ id: 'cp', role: 'system', msg_type: 'compact_checkpoint', seq_index: 2 }),
      usageRow('a2', t0 + 1000, { input_tokens: 50_000, output_tokens: 10 }),
    ];
    const facts = extractSessionFacts(rows);
    expect(facts.cacheSequence).toHaveLength(3);
    expect(facts.cacheSequence[0]).toMatchObject({ kind: 'usage', input: 1000, cacheWrite: 49_000 });
    expect(facts.cacheSequence[1]).toEqual({ kind: 'compaction' });
    expect(facts.cacheSequence[2]).toMatchObject({ kind: 'usage', input: 50_000 });
  });

  it('aggregates per-session and summary-level cacheHealth across the pipeline', () => {
    // Turn 1 writes a 50k prompt; turn 2 re-bills the whole thing at input rate.
    const rows = [
      usageRow('a1', t0, { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 49_000 }),
      usageRow('a2', t0 + 60_000, { input_tokens: 50_000, output_tokens: 10 }),
    ];
    const summary = aggregateUsage([session('s1', rows)], pricedLookup);

    expect(summary.cacheHealth.missCount).toBe(1);
    expect(summary.cacheHealth.missedTokens).toBe(50_000);
    expect(summary.cacheHealth.ttlExpiredMissCount).toBe(0);
    expect(summary.cacheHealth.missedCost).toBeCloseTo((50_000 * (3 - 0.3)) / 1_000_000, 8);
    expect(summary.sessions[0].cacheHealth).toEqual(summary.cacheHealth);
  });

  it('compaction boundary suppresses the miss that would follow it', () => {
    const rows = [
      usageRow('a1', t0, { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 49_000 }),
      msgRow({ id: 'cp', role: 'system', msg_type: 'compact_checkpoint', seq_index: 2 }),
      usageRow('a2', t0 + 1000, { input_tokens: 50_000, output_tokens: 10 }),
    ];
    const summary = aggregateUsage([session('s1', rows)], pricedLookup);
    expect(summary.cacheHealth.missCount).toBe(0);
    expect(summary.cacheHealth.missedTokens).toBe(0);
  });
});

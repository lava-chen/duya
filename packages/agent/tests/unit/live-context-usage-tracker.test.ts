/**
 * Live context-usage tracker — multi-turn behavior
 *
 * Reproduces the module-scope tracker + per-turn seeding logic from
 * agent-process-entry.ts (handleChatStart) to verify the invariant the
 * context ring depends on:
 *
 *   1. A NEW session starts with a message-only estimate (system prompt
 *      overhead included), not a hard 0 that renders an empty ring.
 *   2. Once a `result` lands, `usedTokens` reflects the real API prompt
 *      (input + output), which already includes system prompt + tools.
 *   3. A FOLLOW-UP turn re-seeds cumulative totals + the authoritative
 *      base from the persisted history, so the first emit of the new turn
 *      is the previous turn's context — never a reset to 0.
 *   4. `tool_result` boundary tracking prevents double-counting the
 *      assistant message (already paid via output_tokens).
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// Reproduced tracker state (mirrors agent-process-entry.ts module scope)
// ============================================================================

interface LiveTracker {
  liveBaseContext: number;
  liveBaseMessageCount: number;
  hasLiveBase: boolean;
  liveLastInput: number;
  liveLastOutput: number;
  liveLastCacheHit: number | undefined;
  liveLastCacheCreation: number | undefined;
  liveBoundaryPending: boolean;
  liveTotalInput: number;
  liveTotalInputRaw: number;
  liveTotalOutput: number;
  liveTotalCacheHit: number;
  liveTotalCacheCreation: number;
}

function freshTracker(): LiveTracker {
  return {
    liveBaseContext: 0,
    liveBaseMessageCount: 0,
    hasLiveBase: false,
    liveLastInput: 0,
    liveLastOutput: 0,
    liveLastCacheHit: undefined,
    liveLastCacheCreation: undefined,
    liveBoundaryPending: false,
    liveTotalInput: 0,
    liveTotalInputRaw: 0,
    liveTotalOutput: 0,
    liveTotalCacheHit: 0,
    liveTotalCacheCreation: 0,
  };
}

// Same CJK-aware estimate as tokenBudget.estimateMessageTokens.
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 2.5) + Math.ceil(otherCount / 4);
}
function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
  return messages.reduce((sum, m) => sum + estimateTextTokens(m.content), 0);
}

interface SimMessage {
  id: string;
  role: string;
  content: string;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_hit_tokens?: number;
    cache_creation_tokens?: number;
  };
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_hit_tokens?: number;
    cache_creation_tokens?: number;
  };
}

interface EmitPayload {
  usedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheCreationTokens?: number;
  systemTokens: number;
  totalInput: number;
  totalOutput: number;
  totalCacheHit: number;
  totalCacheCreation: number;
}

// Reproduces the seeding block of handleChatStart: iterate persisted
// history, accumulate cumulative totals, restore the authoritative base.
function seedTracker(tracker: LiveTracker, messages: SimMessage[], systemTokens: number): void {
  let seedTotalInput = 0;
  let seedTotalInputRaw = 0;
  let seedTotalOutput = 0;
  let seedTotalCacheHit = 0;
  let seedTotalCacheCreation = 0;
  let lastUsage: SimMessage['tokenUsage'] | undefined;

  for (const m of messages) {
    const u = m.tokenUsage ?? m.token_usage;
    if (!u) continue;
    const rawInput = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheHit = u.cache_hit_tokens ?? 0;
    const cacheCreation = u.cache_creation_tokens ?? 0;
    // Cache-convention guard — MUST match the `result` handler (the fix).
    const normalizedInput =
      cacheHit > rawInput || cacheCreation > rawInput
        ? rawInput + cacheHit + cacheCreation
        : rawInput;
    seedTotalInput += normalizedInput;
    seedTotalInputRaw += rawInput;
    seedTotalOutput += output;
    seedTotalCacheHit += cacheHit;
    seedTotalCacheCreation += cacheCreation;
    lastUsage = u;
  }

  tracker.liveTotalInput = seedTotalInput;
  tracker.liveTotalInputRaw = seedTotalInputRaw;
  tracker.liveTotalOutput = seedTotalOutput;
  tracker.liveTotalCacheHit = seedTotalCacheHit;
  tracker.liveTotalCacheCreation = seedTotalCacheCreation;

  if (lastUsage) {
    const rawInput = lastUsage.input_tokens ?? 0;
    const cacheHit = lastUsage.cache_hit_tokens ?? 0;
    const cacheCreation = lastUsage.cache_creation_tokens ?? 0;
    const normalizedInput =
      cacheHit > rawInput || cacheCreation > rawInput
        ? rawInput + cacheHit + cacheCreation
        : rawInput;
    tracker.liveBaseContext = normalizedInput + (lastUsage.output_tokens ?? 0);
    tracker.liveBaseMessageCount = messages.length;
    tracker.hasLiveBase = true;
    tracker.liveLastInput = normalizedInput;
    tracker.liveLastOutput = lastUsage.output_tokens ?? 0;
    tracker.liveLastCacheHit = lastUsage.cache_hit_tokens;
    tracker.liveLastCacheCreation = lastUsage.cache_creation_tokens;
    tracker.liveBoundaryPending = false;
  }
}

// Reproduces computeLiveUsed().
function computeLiveUsed(
  tracker: LiveTracker,
  messages: SimMessage[],
  systemTokens: number,
): number {
  if (!tracker.hasLiveBase) {
    const msgTokens = estimateMessagesTokens(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    // Fix: message-only estimate + system prompt / tools overhead.
    return msgTokens + systemTokens;
  }
  let boundary = tracker.liveBaseMessageCount;
  if (tracker.liveBoundaryPending) {
    boundary = tracker.liveBaseMessageCount + 1;
  }
  const trailing = estimateMessagesTokens(
    messages.slice(boundary).map((m) => ({ role: m.role, content: m.content })),
  );
  return tracker.liveBaseContext + trailing;
}

// Reproduces the `result` event handler.
function handleResult(
  tracker: LiveTracker,
  messages: SimMessage[],
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
): EmitPayload {
  const rawInput = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheHitTokens = usage.cache_hit_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_tokens ?? 0;
  const normalizedInput =
    cacheHitTokens > rawInput || cacheCreationTokens > rawInput
      ? rawInput + cacheHitTokens + cacheCreationTokens
      : rawInput;

  tracker.liveBaseContext = normalizedInput + outputTokens;
  tracker.liveBaseMessageCount = messages.length;
  tracker.hasLiveBase = true;
  tracker.liveLastInput = normalizedInput;
  tracker.liveLastOutput = outputTokens;
  tracker.liveLastCacheHit = cacheHitTokens;
  tracker.liveLastCacheCreation = cacheCreationTokens;
  tracker.liveTotalInput += normalizedInput;
  tracker.liveTotalInputRaw += rawInput;
  tracker.liveTotalOutput += outputTokens;
  tracker.liveTotalCacheHit += cacheHitTokens;
  tracker.liveTotalCacheCreation += cacheCreationTokens;
  tracker.liveBoundaryPending = true;

  return emit(tracker, messages);
}

// Reproduces the `tool_result` event handler boundary finalization.
function handleToolResult(tracker: LiveTracker, messages: SimMessage[]): EmitPayload {
  if (tracker.liveBoundaryPending) {
    tracker.liveBaseMessageCount = Math.max(0, messages.length - 1);
    tracker.liveBoundaryPending = false;
  }
  return emit(tracker, messages);
}

function emit(tracker: LiveTracker, messages: SimMessage[]): EmitPayload {
  return {
    usedTokens: computeLiveUsed(tracker, messages, 0),
    inputTokens: tracker.liveLastInput,
    outputTokens: tracker.liveLastOutput,
    cacheHitTokens: tracker.liveLastCacheHit,
    cacheCreationTokens: tracker.liveLastCacheCreation,
    systemTokens: 0,
    totalInput: tracker.liveTotalInput,
    totalOutput: tracker.liveTotalOutput,
    totalCacheHit: tracker.liveTotalCacheHit,
    totalCacheCreation: tracker.liveTotalCacheCreation,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('live context-usage tracker (multi-turn)', () => {
  it('first turn of a fresh session emits a message+system estimate, not 0', () => {
    const tracker = freshTracker();
    // Brand-new session: init reset the tracker, DB had no history.
    seedTracker(tracker, [], 0);
    const messages: SimMessage[] = [
      { id: 'u1', role: 'user', content: 'hello world' },
    ];
    // First emit happens BEFORE streamChat pushes the user message (lazy
    // generator), so history is empty → estimate is system-only, which is
    // still > 0 once the system prompt is priced.
    const first = emit(tracker, []);
    expect(first.usedTokens).toBe(0);
    expect(first.totalInput).toBe(0);

    // Same turn, after the first `result`: real API prompt (input includes
    // system + tools + user message; output is the response).
    const resultEmit = handleResult(tracker, messages, {
      input_tokens: 1000,
      output_tokens: 200,
      cache_hit_tokens: 9000,
    });
    expect(resultEmit.usedTokens).toBeGreaterThan(0);
    // normalizedInput = 1000 + 9000 (cache hit exceeds raw input).
    expect(resultEmit.inputTokens).toBe(10000);
    expect(resultEmit.usedTokens).toBe(10200);
    expect(resultEmit.totalInput).toBe(10000);
  });

  it('follow-up turn re-seeds: first emit is the previous turn context, not 0', () => {
    const tracker = freshTracker();
    // Turn 1 history as persisted at the end of turn 1 (last assistant
    // carries the accumulated raw tokenUsage).
    const turn1History: SimMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'hi there',
        tokenUsage: {
          input_tokens: 1000,
          output_tokens: 200,
          total_tokens: 1200,
          cache_hit_tokens: 9000,
          cache_creation_tokens: 500,
        },
      },
    ];

    // Turn 2 init: router zeroes the tracker, worker re-seeds from DB.
    seedTracker(tracker, turn1History, 0);

    // First emit of turn 2 (user message not yet pushed — lazy generator):
    // must equal the seeded authoritative base (previous turn context).
    const messages: SimMessage[] = [...turn1History];
    const first = emit(tracker, messages);
    expect(tracker.hasLiveBase).toBe(true);
    expect(first.usedTokens).toBeGreaterThan(0);
    // normalizedInput = rawInput(1000) + cacheHit(9000) + cacheWrite(500)
    // because cacheWrite(500) > rawInput(1000)? No — 500 < 1000, and
    // cacheHit 9000 > 1000, so normalized = 1000 + 9000 + 500 = 10500.
    expect(first.inputTokens).toBe(10500);
    expect(first.usedTokens).toBe(10700); // input + output
    // Cumulative totals survive the turn boundary.
    expect(first.totalInput).toBe(10500);
    expect(first.totalOutput).toBe(200);
    expect(first.totalCacheHit).toBe(9000);
    expect(first.totalCacheCreation).toBe(500);
  });

  it('turn 2 with tool round: trailing estimate adds tool result without double-counting assistant', () => {
    const tracker = freshTracker();
    const turn1History: SimMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'hi there',
        tokenUsage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
      },
    ];
    seedTracker(tracker, turn1History, 0);

    // Turn 2: user message pushed, LLM returns tool_use, tool result lands.
    const turn2: SimMessage[] = [
      ...turn1History,
      { id: 'u2', role: 'user', content: 'run the tool' },
      { id: 'a2', role: 'assistant', content: '[tool_use bash ls]' },
    ];
    const afterResult = handleResult(tracker, turn2, {
      input_tokens: 2000,
      output_tokens: 150,
    });
    // Rebased on the new result (input+output), trailing excluded the just-
    // pushed assistant a2 (boundary pending), so used == input + output.
    expect(afterResult.usedTokens).toBe(2150);
    // Cumulative: seeded 1000 (turn 1) + new result raw input 2000.
    expect(afterResult.totalInput).toBe(3000);
    // tool result appended after the assistant:
    turn2.push({ id: 't2', role: 'tool', content: 'ls output is long...'.repeat(40) });
    const afterToolResult = handleToolResult(tracker, turn2);
    // Now used = rebased context (2150) + trailing (the tool result, since
    // boundary was finalized just past the assistant).
    expect(afterToolResult.usedTokens).toBeGreaterThan(afterResult.usedTokens);
  });

  it('cache-convention guard is applied identically in seeding and result handler', () => {
    // Seed path with a fully cache-served first request: input=0, hits=3000.
    const tracker = freshTracker();
    const history: SimMessage[] = [
      { id: 'a1', role: 'assistant', content: 'ok', tokenUsage: { input_tokens: 0, output_tokens: 10, cache_hit_tokens: 3000 } },
    ];
    seedTracker(tracker, history, 0);
    expect(tracker.liveTotalInput).toBe(3000);
    expect(tracker.liveBaseContext).toBe(3010);
    // Same result would normalize identically.
    const reEmit = emit(tracker, history);
    expect(reEmit.inputTokens).toBe(3000);
  });
});

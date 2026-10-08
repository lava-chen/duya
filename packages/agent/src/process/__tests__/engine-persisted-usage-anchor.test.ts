/**
 * Plan 610 P8: the assistant row must persist the turn-cumulative block WITH
 * `last_call`, not the engine's own usage frame.
 *
 * ## What regressed
 *
 * The flip replaced `cumulativeTokenUsageRef` with the engine's own
 * `TurnMessage.addUsage` block, and `toRowUsage` maps exactly three counters
 * out of it. `addUsage` keeps the LAST usage frame of the turn and never the
 * sum (`agent-runtime/src/engine/run-engine.ts:3253-3261`), so the durable row
 * lost two things the engine cannot supply:
 *
 * 1. the cache buckets, which are what let `normalizePromptTokens` tell
 *    Anthropic's `input_tokens`-excludes-cache convention from an OpenAI
 *    gateway's `prompt_tokens`-includes-it one, and
 * 2. `last_call`, the LARGEST-prompt call by anchor volume -- not the latest.
 *
 * Both matter on reload, and they fail in opposite directions. Without the
 * buckets the convention guard cannot fire, so a context whose tail is 500
 * non-cached tokens reloads as 500. Without `last_call` the anchor follows
 * whatever the last frame said, which some gateways report as a near-fresh
 * prefix, so the ring shrinks permanently after a restart.
 *
 * ## Why this drives the REAL assembly path
 *
 * `LegacyRunHost.turnUsageBlock` is a host hook consulted inside
 * `composeLegacyRunPorts`, and the row is committed by
 * `recordTurnAssistantMessage` on its first line -- so a graft applied after
 * that call would decorate an object the store never sees. Calling the port by
 * hand with a hand-made usage would prove nothing about which side wins.
 * Composing through the production function and capturing what the agent was
 * handed is the only thing that settles it.
 *
 * ## Why the sides of each assertion can disagree
 *
 * Every expectation is a literal written here. The actual is what the fake
 * agent captured, through the composition, from the host hook. No assertion
 * compares a value with itself, and the control case deliberately supplies NO
 * hook so the two shapes (host block vs engine block) are visibly different
 * objects rather than the same one read twice.
 */

import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@duya/ai';
import { normalizePromptTokens } from '@duya/ai';
import type {
  AssistantMessageRecord,
  EmitAcceptance,
  RunEnginePorts,
} from '@duya/agent-runtime';
import { composeLegacyRunPorts, type LegacyRunHost } from '../run-composition.js';

/**
 * What the engine's `addUsage` produces: the last usage frame of the turn,
 * three counters, no cache buckets, no `last_call`.
 */
const ENGINE_USAGE = { inputTokens: 500, outputTokens: 20, totalTokens: 520 } as const;

/**
 * What the entry's ledger knows: two provider calls summed, and the
 * largest-prompt one kept as the anchor. The first call is deliberately the
 * LARGER prompt so a "last one wins" implementation cannot pass by accident.
 */
const HOST_BLOCK = {
  input_tokens: 30_000,
  output_tokens: 240,
  total_tokens: 30_240,
  cache_hit_tokens: 29_500,
  cache_creation_tokens: 500,
  last_call: {
    input_tokens: 500,
    output_tokens: 240,
    cache_hit_tokens: 0,
    cache_creation_tokens: 900,
  },
} as const;

interface Captured {
  usage: AssistantMessage['usage'] | undefined;
}

/** The agent surface `composeLegacyRunPorts` closes over, minus the durable write. */
function fakeAgent(captured: Captured): never {
  return {
    bindTurnOutputSink: () => undefined,
    bindRunForkMarker: () => undefined,
    recordTurnAssistantMessage: (input: { usage?: AssistantMessage['usage'] }) => {
      captured.usage = input.usage;
    },
    recordTurnToolResult: () => undefined,
    finishTurnOutput: () => undefined,
    addMessage: () => undefined,
    claimInterTurn: () => ({}),
    getMessages: () => [],
    readModelClient: () => ({}),
    activeMCPRegistry: { getAllTools: () => [], getTool: () => undefined },
    projectRunOwnModelMessages: () => [],
    runModeExitHooks: () => undefined,
    orchestratorFramesFor: () => ({}),
  } as never;
}

/** An emitter that accepts everything; nothing here reads its verdict. */
const ACCEPTED = {
  ok: true,
  envelope: { seq: 0 },
  durable: false,
  terminal: false,
  held: false,
} as unknown as EmitAcceptance;

/** A host with every required member and NO `turnUsageBlock`. */
function baseHost(): LegacyRunHost {
  return {
    turnPipelines: {} as never,
    assembleTurn: (() => ({})) as never,
    refreshDeclaredTools: () => new Set<string>(),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter: { emit: () => ACCEPTED },
    proposeTerminal: () => undefined,
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-usage',
    },
    seqIndex: 0,
    wakeRun: false,
    beginTicket: (() => ({}) as never) as never,
    settleTicket: (() => ({}) as never) as never,
  };
}

const RECORD = {
  turn: 0,
  messageId: 'm-usage',
  content: [],
  usage: { ...ENGINE_USAGE },
} as unknown as AssistantMessageRecord;

/** Compose for real, hand one assistant record over, return what the row got. */
function persistAssistantUsage(turnUsageBlock?: () => AssistantMessage['usage'] | null) {
  const captured: Captured = { usage: undefined };
  const agent = fakeAgent(captured);
  const ports: RunEnginePorts = composeLegacyRunPorts(agent, {
    ...baseHost(),
    ...(turnUsageBlock === undefined ? {} : { turnUsageBlock }),
  });
  const record = ports.turnOutput?.recordAssistantMessage;
  if (record === undefined) throw new Error('turnOutput.recordAssistantMessage is unbound');
  return { captured, run: () => record(RECORD) };
}

describe('the persisted assistant row keeps the host anchor, not the engine frame', () => {
  it('persists last_call and the cache buckets when the host supplies them', async () => {
    const { captured, run } = persistAssistantUsage(() => ({ ...HOST_BLOCK }));
    await run();

    expect(captured.usage).toMatchObject({
      input_tokens: 30_000,
      output_tokens: 240,
      cache_hit_tokens: 29_500,
      cache_creation_tokens: 500,
      last_call: { input_tokens: 500, output_tokens: 240 },
    });
  });

  it('does not persist the engine frame when the host supplied a block', async () => {
    // Guards the direction of the win. `HOST_BLOCK.output_tokens` is 240 and
    // the engine frame's is 20; a regression that kept the engine's block
    // would land 20 here.
    const { captured, run } = persistAssistantUsage(() => ({ ...HOST_BLOCK }));
    await run();

    expect(captured.usage?.output_tokens).not.toBe(ENGINE_USAGE.outputTokens);
  });

  it('still reads last_call back as the context anchor', async () => {
    // The consumer, not this layer, decides the anchor: `normalizePromptTokens`
    // prefers `last_call`. Its cache buckets ride along, so the convention guard
    // fires (cache_write 900 > input 500) and prompt resolves to 500 + 900.
    // The engine frame would have produced 500, because it carries no buckets
    // at all for the guard to reason over.
    const { captured, run } = persistAssistantUsage(() => ({ ...HOST_BLOCK }));
    await run();

    expect(normalizePromptTokens(captured.usage as never)).toEqual({
      prompt: 1_400,
      output: 240,
    });
  });

  it('under-counts the anchor without the hook, which is the regression', async () => {
    // Both rows come out of the SAME composition and are read by the SAME
    // consumer function; only the hook differs. Without it the row carries the
    // engine frame's three counters, so there are no buckets for the
    // convention guard to reason over and the whole cached prefix is invisible.
    const without = persistAssistantUsage();
    await without.run();
    const withHook = persistAssistantUsage(() => ({ ...HOST_BLOCK }));
    await withHook.run();

    expect(normalizePromptTokens(without.captured.usage as never)).toEqual({
      prompt: 500,
      output: 20,
    });
    expect(normalizePromptTokens(withHook.captured.usage as never)).toEqual({
      prompt: 1_400,
      output: 240,
    });
  });

  it('falls back to the engine block for a host with no ledger', async () => {
    // The omission is load-bearing, not defensive: a bare port test and the CLI
    // supply no hook, and they must keep working unchanged.
    const { captured, run } = persistAssistantUsage();
    await run();

    expect(captured.usage).toEqual({
      input_tokens: 500,
      output_tokens: 20,
      total_tokens: 520,
    });
    expect((captured.usage as { last_call?: unknown }).last_call).toBeUndefined();
  });

  it('leaves the row without a usage block when the host ledger is empty', async () => {
    // A null block is "nothing was reported", which is not the same claim as a
    // block of zeros -- a zero asserts no cache read happened.
    const { captured, run } = persistAssistantUsage(() => null);
    await run();

    expect(captured.usage).toEqual({
      input_tokens: 500,
      output_tokens: 20,
      total_tokens: 520,
    });
  });
});
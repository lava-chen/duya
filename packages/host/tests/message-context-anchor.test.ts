import { it, expect } from 'vitest';
import type { Message } from '@duya/agent-protocol/transcript';
import { ingestMessage } from '@duya/agent-protocol';
import { projectTimelinePersistenceMessages } from '@duya/agent-core/message';
import { ipcMessageToNewEvent, storedEventToIpcMessage } from '../src/ipc-message-adapters.js';
const createdAt = 1_700_000_000_000;
  it('the projected anchor satisfies computeContextEstimate semantics', async () => {
    const { computeContextEstimate } = await import('@duya/ai');
    const pushed = {
      id: 'a-ring-2',
      role: 'assistant' as const,
      content: [{ type: 'text', text: 'hi' }],
      timestamp: createdAt,
      usage: { input_tokens: 10, output_tokens: 5, cache_hit_tokens: 100 },
      tokenUsage: { input_tokens: 10, output_tokens: 5, cache_hit_tokens: 100 },
    };
    const ingested = ingestMessage(pushed as unknown as Message, { index: 0 });
    const projected = projectTimelinePersistenceMessages([
      { type: 'message', id: 'evt-2', parentId: null, createdAt, message: ingested },
    ]);

    // This is the exact call emitLiveUsage makes; before the fix the anchor
    // scan found no usage/tokenUsage and returned anchored=false forever.
    const estimate = computeContextEstimate(projected as never);
    expect(estimate.anchored).toBe(true);
    expect(estimate.anchorIndex).toBe(0);
    expect(estimate.usedTokens!).toBeGreaterThan(0);
  });

  /**
   * The WRITER's half of the same contract, asserted on the shape that is
   * actually persisted.
   *
   * `recordTurnAssistantMessage` hands the journal exactly this DTO
   * (`token_usage` as a JSON string; see worker-journal/Journal.ts). The read
   * side already accepted `usage ?? tokenUsage`, but the row reached the
   * rollout with NEITHER field: the runtime wrote `usage`, which the journal
   * and `LEGACY_KNOWN_KEYS` do not carry. Every consumer that rebuilds an
   * anchor from durable history (`/context`, `/cost`, the Desktop ring after a
   * reload) therefore reported "no usage anchor yet" for every session that
   * ever ran on the Host worker.
   */
  it('a journal DTO carrying only token_usage still anchors after the rollout round-trip', async () => {
    const { computeContextEstimate } = await import('@duya/ai/context');
    const turnUsage = {
      // Turn-cumulative: three calls' prompts summed.
      input_tokens: 120_000,
      output_tokens: 300,
      // Plan 445 shape: the final request. Losing `last_call` makes the anchor
      // report Σ prompts over the turn (here 3× the real context).
      last_call: { input_tokens: 40_000, output_tokens: 250 },
      calls: [
        { input_tokens: 40_000, output_tokens: 250 },
        { input_tokens: 40_000, output_tokens: 25 },
        { input_tokens: 40_000, output_tokens: 25 },
      ],
    };
    const event = ipcMessageToNewEvent('s-usage', {
      id: 'a-usage-1',
      session_id: 's-usage',
      role: 'assistant',
      content: 'hi',
      timestamp: createdAt,
      seq_index: 3,
      model: 'claude-test',
      provider_id: 'p1',
      token_usage: JSON.stringify(turnUsage),
    });

    // The rollout line is the durable boundary: a reload reads JSON, not the
    // in-memory object.
    const entry = JSON.parse(JSON.stringify(event.payload));
    const durable: Message = entry.message;
    expect(durable.tokenUsage).toEqual(turnUsage);
    // Kept for the legacy row adapter, which reads the metadata string first.
    expect((durable.metadata as Record<string, unknown>).token_usage).toBe(
      JSON.stringify(turnUsage),
    );

    const projected = projectTimelinePersistenceMessages([entry]);
    const estimate = computeContextEstimate(projected as never);
    expect(estimate.anchored).toBe(true);
    // `normalizePromptTokens` prefers `last_call`: the anchor is the final
    // request's prompt (~40k), not the turn's cumulative Σ (~120k).
    expect(estimate.anchorTokens).toBeGreaterThanOrEqual(40_000);
    expect(estimate.anchorTokens).toBeLessThan(41_000);

    // And the flat row the DB / IPC consumers read keeps carrying it.
    const row = storedEventToIpcMessage({
      id: event.id,
      sessionId: 's-usage',
      seq: 1,
      turnId: null,
      kind: 'message',
      payload: JSON.stringify(entry),
      createdAt,
    });
    expect(row?.token_usage).not.toBeNull();
    expect(JSON.parse(row!.token_usage!)).toMatchObject({
      input_tokens: 120_000,
      last_call: { input_tokens: 40_000 },
    });
  });

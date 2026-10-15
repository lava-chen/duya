import { it, expect } from 'vitest';
import type { Message } from '@duya/agent-protocol/transcript';
import { ingestMessage } from '@duya/agent-protocol';
import { projectTimelinePersistenceMessages } from '@duya/agent-core/message';
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

/**
 * Plan 577 Phase 3 — ContextComposition accounting ("context is not just
 * messages").
 *
 * Locks:
 * ① the bucket taxonomy (conversation / injectedContext / toolResults /
 *    attachments / system / toolDefinitions / memory) with the
 *    `injectedContext` bucket the second review round added — harness
 *    injections stop being invisible inside "conversation";
 * ② the unanchored estimate now charges the tool-definition surface
 *    (options.toolDefinitionsTokens) exactly once, and the anchored path
 *    never charges it (provider input already priced it);
 * ③ the composition is a projection of the SAME measurement:
 *    buckets + unattributedObservedTokens === estimate.usedTokens.
 */

import { describe, it, expect } from 'vitest';
import {
  computeContextComposition,
  contextPartsTotal,
  IMAGE_TOKEN_FLOOR,
  type ContextEstimateMessage,
} from '../src/utils/context-estimate.js';

function assistantAnchor(inputTokens: number, outputTokens: number): ContextEstimateMessage {
  return {
    role: 'assistant',
    content: 'answer',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('ContextComposition bucketing', () => {
  it('routes blocks into conversation / toolResults / attachments / injectedContext', () => {
    // The blocks ride in a user message AFTER the anchor: the anchor's
    // provider-observed volume covers everything up to and including its own
    // request, so only post-anchor messages are locally attributable —
    // bucketing pre-anchor blocks would double-count them.
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 500),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'plain user question' },
          { type: 'text', text: '<system-reminder>runtime injected guidance</system-reminder>' },
          { type: 'tool_result', tool_use_id: 't1', content: 'tool output text' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ],
      },
    ];

    const { estimate, composition } = computeContextComposition(messages);
    expect(estimate.anchored).toBe(true);
    // The anchor is a provider fact — not locally attributable.
    expect(composition.unattributedObservedTokens).toBe(10_000 + 500);
    // The four trailing blocks land in four different buckets.
    expect(composition.conversation.length).toBe(1);
    expect(composition.injectedContext.length).toBe(1);
    expect(composition.toolResults.length).toBe(1);
    expect(composition.attachments.length).toBe(1);
    expect(composition.attachments[0].tokens).toBe(IMAGE_TOKEN_FLOOR);
    // Sum invariant: buckets + unattributed === total.
    const bucketSum =
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments);
    expect(composition.unattributedObservedTokens + bucketSum).toBe(estimate.usedTokens);
  });

  it('classifies a string-content harness injection as injectedContext', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(1_000, 100),
      { role: 'user', content: '[system] background task finished' },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.injectedContext.length).toBe(1);
    expect(composition.conversation.length).toBe(0);
  });

  it('unanchored path: tool definitions are priced once and land in the bucket', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'hello world' },
    ];
    const { estimate, composition } = computeContextComposition(messages, {
      systemPrefixTokens: 1_000,
      toolDefinitionsTokens: 12_000,
    });
    expect(estimate.anchored).toBe(false);
    // used = history(≈3) + system(1000) + tools(12000)
    expect(estimate.usedTokens).toBe(estimate.trailingTokens + 1_000 + 12_000);
    expect(estimate.toolDefinitionsTokens).toBe(12_000);
    expect(contextPartsTotal(composition.toolDefinitions)).toBe(12_000);
    expect(contextPartsTotal(composition.system)).toBe(1_000);
  });

  it('anchored path never double-charges the tool definitions', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(50_000, 1_000),
      { role: 'user', content: 'follow-up' },
    ];
    const { estimate, composition } = computeContextComposition(messages, {
      toolDefinitionsTokens: 12_000,
    });
    expect(estimate.anchored).toBe(true);
    expect(estimate.toolDefinitionsTokens).toBe(0);
    expect(composition.toolDefinitions).toEqual([]);
    // 50k input + persisted "answer" (2 tokens) + trailing follow-up — no tool charge.
    expect(estimate.usedTokens).toBe(50_002 + estimate.trailingTokens);
  });

  it('systemParts / memoryParts label their buckets when provided', () => {
    const messages: ContextEstimateMessage[] = [{ role: 'user', content: 'hi' }];
    const { composition } = computeContextComposition(messages, {
      systemParts: [
        { label: 'core prompt', tokens: 800 },
        { label: 'skills', tokens: 200 },
      ],
      memoryParts: [{ label: 'MEMORY.md', tokens: 700 }],
      toolDefinitionsTokens: 5_000,
      toolDefinitionParts: [
        { label: 'builtin', tokens: 2_000 },
        { label: 'mcp:github', tokens: 3_000 },
      ],
    });
    expect(composition.system).toEqual([
      { label: 'core prompt', tokens: 800 },
      { label: 'skills', tokens: 200 },
    ]);
    expect(composition.memory).toEqual([{ label: 'MEMORY.md', tokens: 700 }]);
    expect(composition.toolDefinitions).toEqual([
      { label: 'builtin', tokens: 2_000 },
      { label: 'mcp:github', tokens: 3_000 },
    ]);
  });

  it('post-compaction "?" estimate yields empty buckets', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'assistant', content: 'old', usage: { input_tokens: 90_000, output_tokens: 10 }, isCompactBoundary: true },
      { role: 'user', content: 'new question after compaction' },
    ];
    const { estimate, composition } = computeContextComposition(messages);
    expect(estimate.usedTokens).toBeNull();
    expect(composition.conversation).toEqual([]);
    expect(composition.unattributedObservedTokens).toBe(0);
  });
});

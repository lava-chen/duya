/**
 * Regression tests for the session-memory compaction strategy's
 * message classifier and the panic-trim tool-round repair.
 *
 * The classifier used to pull REAL user turns into the system bucket by
 * text prefix ("instruction…", "You are…", "system…"), which excluded them
 * from the summarizer input AND folded them away at the compaction
 * boundary — the user's message silently vanished from context.
 * fitCompactedToBudget used to split tool rounds, leaving dangling
 * tool_use / orphan tool_result halves that providers reject.
 */

import { describe, it, expect } from 'vitest';
import { SessionMemoryCompactStrategy } from '../../../src/compact/strategies/SessionMemoryCompactStrategy.js';
import { fitCompactedToBudget } from '../../../src/compact/historySanitize.js';
import type { Message, MessageContent } from '../../../src/types.js';

function userMessage(content: string, id: string): Message {
  return { id, role: 'user', content, timestamp: Date.now() };
}

function assistantMessage(content: string, id: string): Message {
  return { id, role: 'assistant', content: [{ type: 'text', text: content }], timestamp: Date.now() };
}

describe('SessionMemoryCompactStrategy message classification', () => {
  it('keeps user turns that start with system-like text in the summarized conversation', async () => {
    const strategy = new SessionMemoryCompactStrategy({ maxMessagesToKeep: 1, keepRecentTokens: 1 });
    const messages: Message[] = [
      userMessage('instructions for setup: install deps first', 'u-setup'),
      assistantMessage('sure, doing it', 'a-1'),
      userMessage('You are right, continue', 'u-agree'),
      assistantMessage('continuing', 'a-2'),
    ];

    const result = await strategy.compact(messages, { totalTokens: 1000 } as never, { force: true });

    // Both user turns must have gone through the conversation path (i.e.
    // be represented in the compacted range), not the system bucket.
    const compacted = result.messages.find((m) => m.isCompactSummary);
    expect(compacted).toBeDefined();
    const ids = (compacted?.compactedMessageIds ?? []) as string[];
    expect(ids).toContain('u-setup');
    expect(ids).toContain('u-agree');
  });

  it('still routes re-fed compaction summaries into the system bucket', async () => {
    const strategy = new SessionMemoryCompactStrategy({ maxMessagesToKeep: 1, keepRecentTokens: 1 });
    const oldSummary: Message = {
      id: 's-old',
      role: 'system',
      content: 'This session is being continued from a previous conversation.',
      timestamp: Date.now(),
      isCompactSummary: true,
    };
    const messages: Message[] = [
      oldSummary,
      userMessage('hello', 'u-1'),
      assistantMessage('hi', 'a-1'),
    ];

    const result = await strategy.compact(messages, { totalTokens: 1000 } as never, { force: true });

    // The prior summary stays in the system bucket (first slot of the
    // compacted output), never treated as conversation to summarize.
    expect(result.messages[0]?.id).toBe('s-old');
    const newSummary = result.messages.find(
      (m) => m.isCompactSummary && m.id !== 's-old',
    );
    expect(newSummary).toBeDefined();
    const ids = (newSummary?.compactedMessageIds ?? []) as string[];
    expect(ids).toContain('u-1');
  });
});

describe('fitCompactedToBudget tool-round repair', () => {
  const bigText = 'x'.repeat(4000);

  it('drops an assistant tool_use whose result was cut away', () => {
    const messages: Message[] = [
      userMessage(bigText, 'u-1'),
      {
        id: 'a-use',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ] as MessageContent[],
        timestamp: Date.now(),
      },
      { id: 't1-r', role: 'tool', tool_call_id: 't1', content: bigText, timestamp: Date.now() },
      assistantMessage('final', 'a-final'),
    ];

    const out = fitCompactedToBudget(messages, 600);
    const allUses = out.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id!)
        : [],
    );
    const allResults = out.flatMap((m) =>
      m.role === 'tool' && typeof m.tool_call_id === 'string' ? [m.tool_call_id] : [],
    );
    // No dangling use and no orphan result may survive.
    for (const id of allUses) expect(allResults).toContain(id);
    for (const id of allResults) expect(allUses).toContain(id);
    // The final answer is still kept.
    expect(out.some((m) => m.id === 'a-final')).toBe(true);
  });

  it('drops a tail result whose tool_use fell inside the dropped middle', () => {
    const messages: Message[] = [
      userMessage(bigText, 'u-1'),
      assistantMessage('middle answer dropped', 'a-mid'),
      {
        id: 'a-use',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ] as MessageContent[],
        timestamp: Date.now(),
      },
      { id: 't2-r', role: 'tool', tool_call_id: 't2', content: 'small', timestamp: Date.now() },
    ];

    // Budget only fits the head user message; the tail (t2 result) is the
    // last message and would orphan without the repair.
    const out = fitCompactedToBudget(messages, 600);
    const allUses = out.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id!)
        : [],
    );
    expect(allUses).not.toContain('t2');
    const orphanResults = out.filter(
      (m) => m.role === 'tool' && m.tool_call_id === 't2',
    );
    expect(orphanResults).toHaveLength(0);
  });

  it('keeps a complete tool round intact when it fits', () => {
    const messages: Message[] = [
      userMessage('question', 'u-1'),
      {
        id: 'a-use',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
        ] as MessageContent[],
        timestamp: Date.now(),
      },
      { id: 't3-r', role: 'tool', tool_call_id: 't3', content: 'out', timestamp: Date.now() },
      assistantMessage('done', 'a-final'),
    ];

    const out = fitCompactedToBudget(messages, 100000);
    expect(out).toHaveLength(messages.length);
  });
});

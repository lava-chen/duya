import { describe, expect, it } from 'vitest';
import { appendAutoContinueMessage, lastRealUserQuery, persistableMessages } from '../../src/agent/utils/agent-helpers.js';
import type { Message } from '../../src/types.js';

describe('appendAutoContinueMessage', () => {
  it('appends a hidden auto_continue runtime message to the array', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ];

    appendAutoContinueMessage(messages);

    expect(messages).toHaveLength(2);
    const last = messages[1];
    expect(last.role).toBe('user');
    expect(last.metadata).toMatchObject({
      runtimeContext: true,
      source: 'auto_continue',
    });
    expect(String(last.content)).toContain('continue');
  });
});

describe('goal/research continuation durability and anchoring', () => {
  it('keeps goal_summary durable (not in persistableMessages exclusion)', () => {
    const msg = {
      id: 'g2', role: 'user', timestamp: 1, content: 'x',
      metadata: { runtimeContext: true, source: 'goal_summary' },
    } as unknown as Message;
    expect(persistableMessages([msg]).length).toBe(1);
  });

  it('keeps research_continuation durable (not in persistableMessages exclusion)', () => {
    const msg = {
      id: 'r2', role: 'user', timestamp: 1, content: 'x',
      metadata: { runtimeContext: true, source: 'research_continuation' },
    } as unknown as Message;
    expect(persistableMessages([msg]).length).toBe(1);
  });

  it('lastRealUserQuery skips goal_summary and anchors to the real user query', () => {
    const real = { id: 'r', role: 'user', timestamp: 1, content: 'build the feature' } as unknown as Message;
    const goal = { id: 'g', role: 'user', timestamp: 2, content: '<system-reminder>goal</system-reminder>',
      metadata: { runtimeContext: true, source: 'goal_summary' } } as unknown as Message;
    expect(lastRealUserQuery([real, goal])).toBe('build the feature');
  });
});
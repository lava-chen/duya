import { describe, expect, it } from 'vitest';
import { appendAutoContinueMessage } from '../../src/agent/utils/agent-helpers.js';
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
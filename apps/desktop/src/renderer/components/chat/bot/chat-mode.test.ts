import { describe, expect, it } from 'vitest';
import { resolveBotAgentId, resolveChatMode } from './chat-mode';

describe('resolveChatMode', () => {
  it('maps bot: prefixed ids to bot-direct', () => {
    expect(resolveChatMode('bot:test1')).toBe('bot-direct');
    expect(resolveChatMode('bot:test1:abc-123')).toBe('bot-direct');
  });

  it('maps room: prefixed ids to room', () => {
    expect(resolveChatMode('room:ops')).toBe('room');
  });

  it('maps everything else to workspace', () => {
    expect(resolveChatMode('session-abc')).toBe('workspace');
    expect(resolveChatMode('')).toBe('workspace');
    expect(resolveChatMode(null)).toBe('workspace');
    expect(resolveChatMode(undefined)).toBe('workspace');
  });
});

describe('resolveBotAgentId', () => {
  it('extracts the agent id from a placeholder thread id', () => {
    expect(resolveBotAgentId('bot:test1')).toBe('test1');
  });

  it('extracts the agent id from a bound thread id', () => {
    expect(resolveBotAgentId('bot:test1:9f0c1a2b')).toBe('test1');
  });

  it('returns null for non-bot ids', () => {
    expect(resolveBotAgentId('session-abc')).toBeNull();
    expect(resolveBotAgentId('room:ops')).toBeNull();
  });

  it('returns null when the agent segment is empty', () => {
    expect(resolveBotAgentId('bot:')).toBeNull();
  });
});

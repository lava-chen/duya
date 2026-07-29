import { describe, it, expect } from 'vitest';
import { messageRowToMessage } from '../db.js';
import type { MessageRow } from '../db.js';
import type { MessageContent } from '@duya/ai';

describe('signature persistence — messageRowToMessage restoration', () => {
  // Helper: create a base MessageRow with sensible defaults
  function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
    return {
      id: 'msg-1',
      session_id: 'session-1',
      role: 'assistant',
      content: '[]',
      display_content: null,
      name: null,
      tool_call_id: null,
      token_usage: null,
      msg_type: 'text',
      thinking: null,
      tool_name: null,
      tool_input: null,
      parent_tool_call_id: null,
      viz_spec: null,
      status: 'done',
      seq_index: null,
      duration_ms: null,
      sub_agent_id: null,
      attachments: null,
      provider_state: null,
      thinking_signature: null,
      tool_signature: null,
      text_signature: null,
      created_at: 0,
      ...overrides,
    };
  }

  it('restores thinkingSignature from thinking_signature column', () => {
    const content: MessageContent[] = [
      { type: 'thinking', thinking: 'reasoning text' },
      { type: 'text', text: 'answer' },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      msg_type: 'text',
      thinking_signature: 'sig-thinking-123',
    });
    const msg = messageRowToMessage(row);
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as MessageContent[];
    const thinkingBlock = blocks.find(b => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.type === 'thinking' && thinkingBlock.thinkingSignature).toBe('sig-thinking-123');
  });

  it('restores thoughtSignature (tool) from tool_signature column', () => {
    const content: MessageContent[] = [
      { type: 'tool_use', id: 't1', name: 'foo', input: {} },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      msg_type: 'tool_use',
      tool_name: 'foo',
      tool_signature: 'sig-tool-456',
    });
    const msg = messageRowToMessage(row);
    const blocks = msg.content as MessageContent[];
    const toolBlock = blocks.find(b => b.type === 'tool_use');
    expect(toolBlock).toBeDefined();
    expect(toolBlock!.type === 'tool_use' && toolBlock.thoughtSignature).toBe('sig-tool-456');
  });

  it('restores textSignature from text_signature column', () => {
    const content: MessageContent[] = [
      { type: 'text', text: 'hello' },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      msg_type: 'text',
      text_signature: 'sig-text-789',
    });
    const msg = messageRowToMessage(row);
    const blocks = msg.content as MessageContent[];
    const textBlock = blocks.find(b => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock!.type === 'text' && textBlock.textSignature).toBe('sig-text-789');
  });

  it('restores provider state from provider_state column', () => {
    const content: MessageContent[] = [
      { type: 'text', text: 'hello' },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      msg_type: 'text',
      provider_state: JSON.stringify({
        api: 'anthropic',
        providerId: 'minimax-anthropic',
        model: 'MiniMax-M3',
      }),
    });
    const msg = messageRowToMessage(row);
    expect(msg.api).toBe('anthropic');
    expect(msg.providerId).toBe('minimax-anthropic');
    expect(msg.model).toBe('MiniMax-M3');
  });

  it('handles null signatures gracefully', () => {
    const content: MessageContent[] = [
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      thinking_signature: null,
      tool_signature: null,
      text_signature: null,
      provider_state: null,
    });
    const msg = messageRowToMessage(row);
    const blocks = msg.content as MessageContent[];
    const thinkingBlock = blocks.find(b => b.type === 'thinking');
    expect(thinkingBlock!.type === 'thinking' && thinkingBlock.thinkingSignature).toBeUndefined();
    expect(msg.api).toBeUndefined();
    expect(msg.providerId).toBeUndefined();
  });

  it('handles malformed provider_state JSON gracefully', () => {
    const row = makeRow({
      content: JSON.stringify([{ type: 'text', text: 'hello' }]),
      provider_state: '{invalid json',
    });
    const msg = messageRowToMessage(row);
    // Should not throw, should just leave provider fields undefined
    expect(msg.api).toBeUndefined();
    expect(msg.providerId).toBeUndefined();
  });

  it('restores all three signatures simultaneously', () => {
    const content: MessageContent[] = [
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'tool_use', id: 't1', name: 'foo', input: {} },
      { type: 'text', text: 'result' },
    ];
    const row = makeRow({
      content: JSON.stringify(content),
      msg_type: 'text',
      thinking_signature: 'sig-think',
      tool_signature: 'sig-tool',
      text_signature: 'sig-text',
      provider_state: JSON.stringify({ api: 'openai-chat', providerId: 'deepseek', model: 'deepseek-reasoner' }),
    });
    const msg = messageRowToMessage(row);
    const blocks = msg.content as MessageContent[];

    const thinkingBlock = blocks.find(b => b.type === 'thinking');
    expect(thinkingBlock!.type === 'thinking' && thinkingBlock.thinkingSignature).toBe('sig-think');

    const toolBlock = blocks.find(b => b.type === 'tool_use');
    expect(toolBlock!.type === 'tool_use' && toolBlock.thoughtSignature).toBe('sig-tool');

    const textBlock = blocks.find(b => b.type === 'text');
    expect(textBlock!.type === 'text' && textBlock.textSignature).toBe('sig-text');

    expect(msg.api).toBe('openai-chat');
    expect(msg.providerId).toBe('deepseek');
    expect(msg.model).toBe('deepseek-reasoner');
  });
});

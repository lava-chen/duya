import { describe, it, expect } from 'vitest';
import { emitSSE } from '../src/api/emit-sse.js';
import type { AssistantMessageEvent, AssistantMessage, ToolUseContent } from '../src/types.js';

const baseMsg: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: 'anthropic',
  providerId: 'test',
  model: 'test-model',
  usage: { input_tokens: 0, output_tokens: 0 },
  stopReason: 'completed',
  timestamp: 0,
};

describe('emitSSE', () => {
  it('returns null for start event', () => {
    const event: AssistantMessageEvent = { type: 'start', partial: baseMsg };
    expect(emitSSE(event)).toBeNull();
  });

  it('maps text_delta to SSEEvent.text (incremental content)', () => {
    const event: AssistantMessageEvent = {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'text', data: 'hello' });
  });

  it('suppresses text_end (content already streamed via text_delta)', () => {
    const event: AssistantMessageEvent = {
      type: 'text_end',
      contentIndex: 0,
      content: 'hello world',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toBeNull();
  });

  it('maps thinking_delta to SSEEvent.thinking (incremental content)', () => {
    const event: AssistantMessageEvent = {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'thinking...',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'thinking', data: 'thinking...' });
  });

  describe('thinking signature forwarding', () => {
    const msgWithSignature = (): AssistantMessage => ({
      ...baseMsg,
      content: [{ type: 'thinking', thinking: 'thought', thinkingSignature: 'sig-123' }],
    });

    it('forwards the signature on thinking_delta when the block carries one', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'more',
        partial: msgWithSignature(),
      };
      expect(emitSSE(event)).toEqual({
        type: 'thinking',
        data: 'more',
        signature: 'sig-123',
      });
    });

    it('omits the signature on thinking_delta when the block is unsigned', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'thinking...',
        partial: { ...baseMsg, content: [{ type: 'thinking', thinking: '', thinkingSignature: '' }] },
      };
      expect(emitSSE(event)).toEqual({ type: 'thinking', data: 'thinking...' });
    });

    it('emits an empty-data thinking event carrying the signature on thinking_end', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_end',
        contentIndex: 0,
        content: 'full thought',
        partial: msgWithSignature(),
      };
      expect(emitSSE(event)).toEqual({ type: 'thinking', data: '', signature: 'sig-123' });
    });

    it('still suppresses thinking_end when the block is unsigned', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_end',
        contentIndex: 0,
        content: 'full thought',
        partial: { ...baseMsg, content: [{ type: 'thinking', thinking: 'full thought' }] },
      };
      expect(emitSSE(event)).toBeNull();
    });

    it('emits an empty-data thinking event carrying redacted flag and encrypted payload', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_end',
        contentIndex: 0,
        content: '',
        partial: {
          ...baseMsg,
          content: [{ type: 'thinking', thinking: '', redacted: true, encrypted: 'enc-payload' }],
        },
      };
      expect(emitSSE(event)).toEqual({
        type: 'thinking',
        data: '',
        redacted: true,
        encrypted: 'enc-payload',
      });
    });

    it('forwards the redacted flag even without a payload (block dropped at replay)', () => {
      const event: AssistantMessageEvent = {
        type: 'thinking_end',
        contentIndex: 0,
        content: '',
        partial: {
          ...baseMsg,
          content: [{ type: 'thinking', thinking: '', redacted: true }],
        },
      };
      expect(emitSSE(event)).toEqual({ type: 'thinking', data: '', redacted: true });
    });
  });

  it('forwards thoughtSignature on toolcall_end', () => {
    const toolCall: ToolUseContent = {
      type: 'tool_use',
      id: 't1',
      name: 'search',
      input: { q: 'x' },
      thoughtSignature: 'thought-sig-1',
    };
    const event: AssistantMessageEvent = {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall,
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({
      type: 'tool_use',
      data: { id: 't1', name: 'search', input: { q: 'x' }, signature: 'thought-sig-1' },
    });
  });

  it('maps toolcall_end to SSEEvent.tool_use', () => {
    const toolCall: ToolUseContent = { type: 'tool_use', id: 't1', name: 'foo', input: { x: 1 } };
    const event: AssistantMessageEvent = {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall,
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'tool_use', data: { id: 't1', name: 'foo', input: { x: 1 } } });
  });

  it('maps done to SSEEvent.done', () => {
    const event: AssistantMessageEvent = {
      type: 'done',
      reason: 'completed',
      message: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'done', reason: 'completed' });
  });

  it('maps error to SSEEvent.error', () => {
    const event: AssistantMessageEvent = {
      type: 'error',
      reason: 'something broke',
      error: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'error', data: 'something broke', code: undefined });
  });
});

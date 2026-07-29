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

  it('maps text_delta to SSEEvent.text_delta', () => {
    const event: AssistantMessageEvent = {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'text_delta', data: 'hello' });
  });

  it('maps text_end to SSEEvent.text', () => {
    const event: AssistantMessageEvent = {
      type: 'text_end',
      contentIndex: 0,
      content: 'hello world',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'text', data: 'hello world' });
  });

  it('maps thinking_delta to SSEEvent.thinking_delta', () => {
    const event: AssistantMessageEvent = {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'thinking...',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'thinking_delta', data: 'thinking...' });
  });

  it('maps thinking_end to SSEEvent.thinking', () => {
    const event: AssistantMessageEvent = {
      type: 'thinking_end',
      contentIndex: 0,
      content: 'full thought',
      partial: baseMsg,
    };
    expect(emitSSE(event)).toEqual({ type: 'thinking', data: 'full thought' });
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

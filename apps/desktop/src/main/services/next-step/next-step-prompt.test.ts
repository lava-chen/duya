import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../ipc/core-db-adapters';
import { buildNextStepPrompt, parseNextStepSuggestions } from './next-step-prompt';

function row(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'm1',
    session_id: 's1',
    role: 'user',
    content: '',
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
    status: 'ok',
    seq_index: 0,
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

describe('buildNextStepPrompt', () => {
  it('keeps only user/assistant roles and labels the transcript', () => {
    const { userContent } = buildNextStepPrompt([
      row({ role: 'user', content: '帮我写一个爬虫' }),
      row({ role: 'tool', content: 'tool output' }),
      row({ role: 'assistant', content: '已完成' }),
    ]);
    expect(userContent).toContain('[USER]: 帮我写一个爬虫');
    expect(userContent).toContain('[ASSISTANT]: 已完成');
    expect(userContent).not.toContain('tool output');
  });

  it('truncates long messages and keeps only recent ones', () => {
    const long = 'x'.repeat(1000);
    const messages = Array.from({ length: 30 }, (_, i) =>
      row({ seq_index: i, content: `${i}-${long}` }),
    );
    const { userContent } = buildNextStepPrompt(messages);
    // Only last 20 kept (indexes 10..29) → message 10 is the oldest survivor.
    expect(userContent).toContain('[USER]: 10-');
    expect(userContent).not.toContain('[USER]: 9-');
    // Truncated to 400 chars total (prefix included) + ellipsis.
    expect(userContent).toContain(`[USER]: 10-${'x'.repeat(397)}...`);
    expect(userContent).not.toContain(long);
  });

  it('asks for strict JSON with three suggestions in the system prompt', () => {
    const { systemPrompt } = buildNextStepPrompt([row({ content: 'hi' })]);
    expect(systemPrompt).toContain('"suggestions"');
    expect(systemPrompt.toLowerCase()).toContain('exactly 3');
  });
});

describe('parseNextStepSuggestions', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"suggestions":["加个重试","跑一下测试","补个文档"]}';
    expect(parseNextStepSuggestions(raw)).toEqual(['加个重试', '跑一下测试', '补个文档']);
  });

  it('strips markdown fences around the JSON', () => {
    const raw = '```json\n{"suggestions":["a","b"]}\n```';
    expect(parseNextStepSuggestions(raw)).toEqual(['a', 'b']);
  });

  it('tolerates surrounding chatter before/after the object', () => {
    const raw = 'Here you go:\n{"suggestions":["x","y","z"]}\nDone.';
    expect(parseNextStepSuggestions(raw)).toEqual(['x', 'y', 'z']);
  });

  it('caps at three suggestions and drops non-string entries', () => {
    const raw = '{"suggestions":["a",42,"b",null,"c","d"]}';
    expect(parseNextStepSuggestions(raw)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for garbage, missing field, or null input', () => {
    expect(parseNextStepSuggestions(null)).toEqual([]);
    expect(parseNextStepSuggestions('')).toEqual([]);
    expect(parseNextStepSuggestions('no json here')).toEqual([]);
    expect(parseNextStepSuggestions('{"other":[]}')).toEqual([]);
    expect(parseNextStepSuggestions('{broken')).toEqual([]);
  });
});

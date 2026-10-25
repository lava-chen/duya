/**
 * Turn suggestion tests.
 *
 * The prediction is one short prompt in the user's voice, and silence is a
 * real answer: a wrong suggestion costs the user more attention than no
 * suggestion at all. These tests pin the filters that keep the useless
 * answers out of the composer's placeholder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTurnSuggestionInput,
  parseTurnSuggestion,
} from '../../src/worker-session/turn-suggestion.js';
import type { Message } from '@duya/agent-core/message';

function msg(role: Message['role'], content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('parseTurnSuggestion', () => {
  it('keeps a plain suggestion', () => {
    expect(parseTurnSuggestion('run the tests')).toBe('run the tests');
    expect(parseTurnSuggestion('跑一下测试')).toBe('跑一下测试');
  });

  it('strips quotes and a leading label', () => {
    expect(parseTurnSuggestion('"run the tests"')).toBe('run the tests');
    expect(parseTurnSuggestion('下一步：跑一下测试')).toBe('跑一下测试');
    expect(parseTurnSuggestion('Suggestion: commit this')).toBe('commit this');
  });

  it('treats an explicit "no idea" as no suggestion', () => {
    expect(parseTurnSuggestion('NONE')).toBeNull();
    expect(parseTurnSuggestion('none')).toBeNull();
    expect(parseTurnSuggestion('无')).toBeNull();
    expect(parseTurnSuggestion('没有')).toBeNull();
    expect(parseTurnSuggestion('There is no obvious next step')).toBeNull();
    expect(parseTurnSuggestion('没有明显的下一步')).toBeNull();
  });

  it('rejects the agent voice, filler and paragraphs', () => {
    expect(parseTurnSuggestion('Let me run the tests')).toBeNull();
    expect(parseTurnSuggestion('我来跑一下测试')).toBeNull();
    expect(parseTurnSuggestion('thanks')).toBeNull();
    expect(parseTurnSuggestion('looks good')).toBeNull();
    expect(parseTurnSuggestion('run the tests. then commit')).toBeNull();
    expect(parseTurnSuggestion('run **the** tests')).toBeNull();
  });

  it('rejects an empty answer and one that is too long', () => {
    expect(parseTurnSuggestion('')).toBeNull();
    expect(parseTurnSuggestion(null)).toBeNull();
    expect(parseTurnSuggestion('x'.repeat(80))).toBeNull();
    // A Chinese suggestion is capped tighter than an English one.
    expect(parseTurnSuggestion('这是一个非常非常非常非常非常长的中文建议句子')).toBeNull();
  });

  it('rejects a single English word but keeps a short Chinese phrase', () => {
    expect(parseTurnSuggestion('tests')).toBeNull();
    expect(parseTurnSuggestion('跑测试')).toBe('跑测试');
  });
});

describe('buildTurnSuggestionInput', () => {
  it('keeps user and assistant text and drops the rest', () => {
    const input = buildTurnSuggestionInput([
      msg('user', '修复登录报错'),
      msg('assistant', '已经修好了'),
      msg('system', '系统提示'),
    ]);

    expect(input).toContain('[USER]: 修复登录报错');
    expect(input).toContain('[ASSISTANT]: 已经修好了');
    expect(input).not.toContain('[SYSTEM]');
  });

  it('keeps only the tail of a long conversation', () => {
    const messages = Array.from({ length: 30 }, (_, index) => msg('user', `第 ${index} 轮`));
    const input = buildTurnSuggestionInput(messages);

    expect(input).toContain('[USER]: 第 29 轮');
    expect(input).not.toContain('第 0 轮');
  });
});

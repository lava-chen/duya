import { describe, expect, it } from 'vitest';
import { findPluginMentionSpans, resolveDirectSlash, resolveItemSelection } from './message-input-logic';
import type { PluginMentionTarget } from './message-input-logic';
import type { PopoverItem } from '@/types/slash-command';

describe('slash command input behavior', () => {
  const skill: PopoverItem = {
    label: '/docx',
    value: '/docx',
    kind: 'agent_skill',
    group: 'skills',
  };

  it('inserts a selected skill into the message text', () => {
    expect(resolveItemSelection(skill, 'skill', 0, '/do', 'do')).toEqual({
      action: 'insert_slash_command',
      commandValue: '/docx',
      newInputValue: '/docx ',
    });
  });

  it('replaces only the active slash fragment', () => {
    expect(resolveItemSelection(skill, 'skill', 6, 'hello /do world', 'do').newInputValue)
      .toBe('hello /docx world');
  });

  it('sends skill commands as normal message content', () => {
    expect(resolveDirectSlash('/docx')).toEqual({ action: 'not_slash' });
    expect(resolveDirectSlash('/docx update this file')).toEqual({ action: 'not_slash' });
  });

  it('keeps immediate local commands immediate', () => {
    expect(resolveDirectSlash('/help')).toEqual({
      action: 'immediate_command',
      commandValue: '/help',
    });
  });
});

describe('findPluginMentionSpans', () => {
  const targets: PluginMentionTarget[] = [
    { pluginId: 'wechat-pay', name: 'WeChat Pay' },
    { pluginId: 'mcp.search', name: 'MCP Search' },
  ];

  it('resolves a mid-sentence token by plugin id and keeps the boundary', () => {
    const text = 'hello @wechat-pay world';
    expect(findPluginMentionSpans(text, targets)).toEqual([
      { start: 6, end: 17, token: '@wechat-pay', pluginId: 'wechat-pay' },
    ]);
  });

  it('resolves the slugified display name', () => {
    expect(findPluginMentionSpans('ask @mcp-search', targets)[0]).toMatchObject({
      pluginId: 'mcp.search',
      token: '@mcp-search',
    });
  });

  it('ignores unresolved tokens, emails, and mid-word at-signs', () => {
    expect(findPluginMentionSpans('email me @home', targets)).toEqual([]);
    expect(findPluginMentionSpans('foo@wechat-pay', targets)).toEqual([]);
    expect(findPluginMentionSpans('@nobody', targets)).toEqual([]);
  });

  it('finds multiple mentions in order', () => {
    const spans = findPluginMentionSpans('@wechat-pay then @mcp-search', targets);
    expect(spans.map((s) => s.token)).toEqual(['@wechat-pay', '@mcp-search']);
  });
});

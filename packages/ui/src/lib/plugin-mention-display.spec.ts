import { describe, expect, it } from 'vitest';
import { splitPluginMentionText } from './plugin-mention-display';
import type { PluginMentionTarget } from './message-input-logic';

const targets: PluginMentionTarget[] = [
  { pluginId: 'wechat-pay', name: 'WeChat Pay', iconUrl: 'duya-file:///icons/wechat.svg' },
];

describe('splitPluginMentionText', () => {
  it('returns a single text segment when nothing resolves', () => {
    expect(splitPluginMentionText('email me @home', targets)).toEqual([
      { type: 'text', value: 'email me @home' },
    ]);
  });

  it('returns no segments for empty text', () => {
    expect(splitPluginMentionText('', targets)).toEqual([]);
  });

  it('chips a bare @token and keeps surrounding text intact', () => {
    expect(splitPluginMentionText('use @wechat-pay now', targets)).toEqual([
      { type: 'text', value: 'use ' },
      {
        type: 'mention',
        pluginId: 'wechat-pay',
        label: 'WeChat Pay',
        iconUrl: 'duya-file:///icons/wechat.svg',
      },
      { type: 'text', value: ' now' },
    ]);
  });

  it('renders the structured link form using the installed display name', () => {
    const segments = splitPluginMentionText('use [@Old Name](plugin://wechat-pay) now', targets);
    expect(segments[1]).toEqual({
      type: 'mention',
      pluginId: 'wechat-pay',
      label: 'WeChat Pay',
      iconUrl: 'duya-file:///icons/wechat.svg',
    });
    expect(segments[0]).toEqual({ type: 'text', value: 'use ' });
    expect(segments[2]).toEqual({ type: 'text', value: ' now' });
  });

  it('falls back to the link label for a plugin that is not installed', () => {
    const segments = splitPluginMentionText('[@Ghost](plugin://ghost) here', targets);
    expect(segments[0]).toEqual({
      type: 'mention',
      pluginId: 'ghost',
      label: 'Ghost',
      iconUrl: undefined,
    });
  });

  it('does not double-chip the @Name inside a structured link', () => {
    const segments = splitPluginMentionText('[@WeChat Pay](plugin://wechat-pay)', targets);
    expect(segments.filter((s) => s.type === 'mention')).toHaveLength(1);
  });

  it('chips multiple bare tokens in order', () => {
    const many: PluginMentionTarget[] = [
      { pluginId: 'a', name: 'Alpha' },
      { pluginId: 'b', name: 'Beta' },
    ];
    const segments = splitPluginMentionText('@a and @b', many);
    expect(segments.map((s) => (s.type === 'mention' ? s.label : s.value))).toEqual([
      'Alpha',
      ' and ',
      'Beta',
    ]);
  });
});

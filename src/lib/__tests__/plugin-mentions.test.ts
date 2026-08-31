/**
 * Tests for plugin mention rewriting (src/lib/plugin-mentions.ts).
 */
import { describe, expect, it } from 'vitest';
import { rewritePluginMentionTokens, type PluginMentionCapabilities } from '../plugin-mentions';

function plugin(overrides: Partial<PluginMentionCapabilities> & { pluginId: string }): PluginMentionCapabilities {
  return {
    name: overrides.pluginId,
    description: undefined,
    appConnections: [],
    mcpServers: [],
    skillNames: [],
    ...overrides,
  };
}

const wechatPay = plugin({
  pluginId: 'wechat-pay',
  name: 'WeChat Pay',
  appConnections: ['wechat_pay'],
  mcpServers: ['wechat-pay-server'],
  skillNames: ['wechat-pay-setup'],
});
const office = plugin({
  pluginId: 'office-suite',
  name: 'Office Suite',
  appConnections: ['notion', 'slack'],
  mcpServers: ['office-mcp'],
  skillNames: [],
});
const plain = plugin({ pluginId: 'data-viewer' });

describe('rewritePluginMentionTokens', () => {
  it('leaves content without @ untouched', () => {
    const r = rewritePluginMentionTokens('hello world', [wechatPay], [], []);
    expect(r.content).toBe('hello world');
    expect(r.mentionedPlugins).toEqual([]);
    expect(r.mergedProviders).toEqual([]);
  });

  it('rewrites a bare @pluginId into a structured link', () => {
    const r = rewritePluginMentionTokens('use @wechat-pay to charge', [wechatPay], [], []);
    expect(r.content).toBe('use [@WeChat Pay](plugin://wechat-pay) to charge');
    expect(r.mentionedPlugins.map((p) => p.pluginId)).toEqual(['wechat-pay']);
  });

  it('matches by display name slug (case-insensitive)', () => {
    const r = rewritePluginMentionTokens('use @wechat-pay please', [wechatPay], [], []);
    expect(r.content).toBe('use [@WeChat Pay](plugin://wechat-pay) please');
    expect(r.mentionedPlugins.map((p) => p.pluginId)).toEqual(['wechat-pay']);
  });

  it('CJK boundary: rewrites with no space before @', () => {
    const r = rewritePluginMentionTokens('看看我的@wechat-pay设置', [wechatPay], [], []);
    expect(r.content).toBe('看看我的[@WeChat Pay](plugin://wechat-pay)设置');
  });

  it('keeps already-encoded links verbatim and counts them once', () => {
    const r = rewritePluginMentionTokens(
      'see [@WeChat Pay](plugin://wechat-pay) and [@WeChat Pay](plugin://wechat-pay) again',
      [wechatPay],
      [],
      [],
    );
    expect(r.content).toContain('[@WeChat Pay](plugin://wechat-pay)');
    expect(r.mentionedPlugins).toHaveLength(1);
  });

  it('merges connected app connectors of mentioned plugins into mergedProviders', () => {
    const r = rewritePluginMentionTokens(
      'use @office-suite for docs',
      [office],
      ['notion', 'slack', 'github'],
      [],
    );
    expect(r.mergedProviders.sort()).toEqual(['notion', 'slack']);
  });

  it('only merges CONNECTED apps — disconnected declarations stay out', () => {
    const r = rewritePluginMentionTokens('use @office-suite for docs', [office], ['notion'], []);
    expect(r.mergedProviders).toEqual(['notion']);
  });

  it('preserves existing providers and appends connected plugin apps after them', () => {
    const r = rewritePluginMentionTokens('use @office-suite', [office], ['notion', 'slack'], ['github']);
    expect(r.mergedProviders).toEqual(['github', 'notion', 'slack']);
  });

  it('does not duplicate a provider already mentioned', () => {
    const r = rewritePluginMentionTokens('use @office-suite', [office], ['notion', 'slack'], ['notion']);
    expect(r.mergedProviders).toEqual(['notion', 'slack']);
  });

  it('unknown @tokens pass through untouched (fail-open)', () => {
    const r = rewritePluginMentionTokens('email me @home', [plain], [], []);
    expect(r.content).toBe('email me @home');
    expect(r.mentionedPlugins).toEqual([]);
  });

  it('plugin with no capabilities still gets a link', () => {
    const r = rewritePluginMentionTokens('open @data-viewer', [plain], [], []);
    expect(r.content).toBe('open [@data-viewer](plugin://data-viewer)');
    expect(r.mergedProviders).toEqual([]);
  });

  it('dedupes repeated mentions of the same plugin', () => {
    const r = rewritePluginMentionTokens('@wechat-pay then @wechat-pay', [wechatPay], [], []);
    expect(r.mentionedPlugins).toHaveLength(1);
    expect(r.mentionedPlugins[0].mcpServers).toEqual(['wechat-pay-server']);
  });
});

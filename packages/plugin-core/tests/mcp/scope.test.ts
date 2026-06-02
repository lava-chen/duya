import { describe, it, expect } from 'vitest';
import {
  PLUGIN_SCOPE_PREFIX,
  MCP_INTERNAL_PREFIX,
  MCP_INTERNAL_SEP,
  scopedPluginServerName,
  toolInternalKey,
  unscopedServerName,
  pluginIdFromScopedName,
  isPluginScopedName,
  buildInventoryId,
} from '../../src/mcp/scope.js';

describe('scopedPluginServerName', () => {
  it('builds the canonical plugin-scoped name', () => {
    expect(scopedPluginServerName('com.duya.lit', 'literature')).toBe(
      'plugin:com.duya.lit:literature',
    );
  });

  it('does not normalize colons inside the pluginId', () => {
    // Plugin ids are opaque; if one contains ':' the function preserves it.
    // isPluginScopedName will still recognize the result.
    const result = scopedPluginServerName('weird:id', 'server');
    expect(result.startsWith(PLUGIN_SCOPE_PREFIX)).toBe(true);
  });
});

describe('toolInternalKey', () => {
  it('prefixes and joins with the configured separator', () => {
    expect(
      toolInternalKey('plugin:com.duya.lit:literature', 'add_source'),
    ).toBe('mcp__plugin:com.duya.lit:literature__add_source');
  });

  it('uniqueness across plugins (different server scopes)', () => {
    const a = toolInternalKey('plugin:pluginA:search', 'query');
    const b = toolInternalKey('plugin:pluginB:search', 'query');
    expect(a).not.toBe(b);
  });

  it('uniqueness across sources (plugin vs user)', () => {
    const fromPlugin = toolInternalKey('plugin:com.duya.lit:literature', 'add_source');
    const fromUser = toolInternalKey('literature', 'add_source');
    expect(fromPlugin).not.toBe(fromUser);
  });

  it('uses MCP_INTERNAL_PREFIX and MCP_INTERNAL_SEP', () => {
    const key = toolInternalKey('plugin:pluginA:search', 'query');
    expect(key.startsWith(MCP_INTERNAL_PREFIX)).toBe(true);
    expect(key).toContain(MCP_INTERNAL_SEP);
  });
});

describe('unscopedServerName', () => {
  it('strips the plugin: prefix and returns the original name', () => {
    expect(unscopedServerName('plugin:com.duya.lit:literature')).toBe('literature');
  });

  it('returns the input unchanged for non-scoped names', () => {
    expect(unscopedServerName('literature')).toBe('literature');
  });

  it('round-trips with scopedPluginServerName', () => {
    const original = 'add_source';
    const scoped = scopedPluginServerName('pluginA', original);
    expect(unscopedServerName(scoped)).toBe(original);
  });

  it('handles server names that themselves contain a colon', () => {
    expect(unscopedServerName('plugin:pluginA:ns:server')).toBe('ns:server');
  });
});

describe('pluginIdFromScopedName', () => {
  it('returns the plugin id portion', () => {
    expect(pluginIdFromScopedName('plugin:com.duya.lit:literature')).toBe('com.duya.lit');
  });

  it('returns undefined for non-scoped names', () => {
    expect(pluginIdFromScopedName('literature')).toBeUndefined();
  });
});

describe('isPluginScopedName', () => {
  it('returns true for well-formed plugin-scoped names', () => {
    expect(isPluginScopedName('plugin:foo:bar')).toBe(true);
  });

  it('returns false for the bare prefix with no name', () => {
    expect(isPluginScopedName('plugin:')).toBe(false);
  });

  it('returns false for the prefix with no separator', () => {
    expect(isPluginScopedName('plugin')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isPluginScopedName('')).toBe(false);
  });

  it('returns false for an unscoped name', () => {
    expect(isPluginScopedName('literature')).toBe(false);
  });
});

describe('buildInventoryId', () => {
  it('builds a bundled id with no plugin/sub fields', () => {
    expect(buildInventoryId({ source: 'bundled', serverName: 'literature' })).toBe(
      'bundled:literature',
    );
  });

  it('builds a plugin id with the pluginId component', () => {
    expect(
      buildInventoryId({
        source: 'plugin',
        pluginId: 'com.duya.lit',
        serverName: 'literature',
      }),
    ).toBe('plugin:com.duya.lit:literature');
  });

  it('builds a settings id with the sub-origin', () => {
    expect(
      buildInventoryId({
        source: 'settings',
        sourceSubOrigin: 'agentSettings',
        serverName: 'literature',
      }),
    ).toBe('settings:agentSettings:literature');
  });

  it('defaults the sub-origin to agentSettings when missing', () => {
    expect(buildInventoryId({ source: 'settings', serverName: 'x' })).toBe(
      'settings:agentSettings:x',
    );
  });

  it('falls back to a placeholder when a plugin id is missing', () => {
    expect(buildInventoryId({ source: 'plugin', serverName: 'x' })).toBe(
      'plugin:<unknown-plugin>:x',
    );
  });
});

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_FALLBACK_REPLACEMENTS,
  findBuiltinFallbackReplacement,
} from '../../src/mcp/discovery.js';

describe('BUILTIN_FALLBACK_REPLACEMENTS', () => {
  it('contains the documented literature pair', () => {
    expect(BUILTIN_FALLBACK_REPLACEMENTS).toContainEqual({
      bundledServerName: 'literature',
      pluginId: 'com.duya.literature',
      pluginServerName: 'literature',
    });
  });

  it('is a non-empty array of well-formed entries', () => {
    expect(BUILTIN_FALLBACK_REPLACEMENTS.length).toBeGreaterThan(0);
    for (const pair of BUILTIN_FALLBACK_REPLACEMENTS) {
      expect(pair.bundledServerName.length).toBeGreaterThan(0);
      expect(pair.pluginId.length).toBeGreaterThan(0);
      expect(pair.pluginServerName.length).toBeGreaterThan(0);
    }
  });
});

describe('findBuiltinFallbackReplacement', () => {
  it('returns the matching plugin inventory id when a replacement plugin is present', () => {
    const plugins = new Set<string>(['plugin:com.duya.literature:literature']);
    const result = findBuiltinFallbackReplacement('literature', plugins);
    expect(result).toBe('plugin:com.duya.literature:literature');
  });

  it('returns undefined when the bundled server name is not a known fallback', () => {
    const plugins = new Set<string>(['plugin:com.duya.literature:literature']);
    const result = findBuiltinFallbackReplacement('other-server', plugins);
    expect(result).toBeUndefined();
  });

  it('returns undefined when the replacement plugin is not installed or not enabled', () => {
    const plugins = new Set<string>(['plugin:com.example.other:other']);
    const result = findBuiltinFallbackReplacement('literature', plugins);
    expect(result).toBeUndefined();
  });

  it('returns undefined when the plugins set is empty', () => {
    const result = findBuiltinFallbackReplacement('literature', new Set());
    expect(result).toBeUndefined();
  });

  it('does NOT match a plugin with the same id but a different server name', () => {
    // e.g. plugin 'com.duya.literature' exports a different MCP server
    // called 'evidence'; that does not replace the bundled 'literature'.
    const plugins = new Set<string>(['plugin:com.duya.literature:evidence']);
    const result = findBuiltinFallbackReplacement('literature', plugins);
    expect(result).toBeUndefined();
  });

  it('does NOT match via prefix alone (string-prefix bug guard)', () => {
    // 'plugin:com.duya.literature:literature-extra' should NOT match
    // the pair whose pluginServerName is 'literature'.
    const plugins = new Set<string>(['plugin:com.duya.literature:literature-extra']);
    const result = findBuiltinFallbackReplacement('literature', plugins);
    expect(result).toBeUndefined();
  });
});

// packages/plugin-core/tests/mcp/compute-provider-name.test.ts
// Phase 2A Batch A: unit tests for the high-level MCP tool-name
// allocator `computeProviderName` defined in
// `packages/plugin-core/src/mcp/provider-tool-name.ts`.
//
// These tests pin the contract that Batch B / C will rely on:
//   - `mcp_` provider-visible prefix is always present
//   - result fits `policy.maxLength`
//   - result matches `policy.allowedCharRegex` on every char
//   - collision against `usedNames` produces `__2` / `__3` suffixes
//   - overlong base names fall back to a stable hash-suffixed form
//   - same input + same usedNames → same output (pure)
//   - builtin names (no `mcp_` prefix) are never produced

import { describe, it, expect } from 'vitest';
import {
  computeProviderName,
  AnthropicToolNamePolicy,
  MCP_PROVIDER_PREFIX,
} from '../../src/mcp/provider-tool-name.js';

describe('computeProviderName — basic shape', () => {
  it('returns a name with the mcp_ provider-visible prefix', () => {
    const out = computeProviderName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out.startsWith('mcp_')).toBe(true);
  });

  it('sanitizes ":" and "." from the scoped server name', () => {
    const out = computeProviderName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out).not.toContain(':');
    expect(out).not.toContain('.');
    // Every char matches the policy.
    for (const ch of out) {
      expect(ch).toMatch(AnthropicToolNamePolicy.allowedCharRegex);
    }
  });

  it('preserves alphanumeric / underscore / hyphen characters', () => {
    const out = computeProviderName(
      'mcp__plugin:foo__hello-world_42',
      new Set(),
      AnthropicToolNamePolicy,
    );
    // mcp__ stripped → "plugin:foo__hello-world_42"
    // ":" → "_" → "plugin_foo__hello-world_42"
    // "__" run collapsed to "_" → "plugin_foo_hello-world_42"
    // + "mcp_" prefix → "mcp_plugin_foo_hello-world_42"
    expect(out).toBe('mcp_plugin_foo_hello-world_42');
  });

  it('keeps the original tool name in the result (not just the scoped server name)', () => {
    // Both `serverA__query` and `serverA__search` must produce
    // distinct provider names — they share the same scoped server
    // but expose different tools.
    const a = computeProviderName('mcp__serverA__query', new Set(), AnthropicToolNamePolicy);
    const b = computeProviderName('mcp__serverA__search', new Set(), AnthropicToolNamePolicy);
    expect(a).not.toBe(b);
    expect(a).toContain('query');
    expect(b).toContain('search');
  });
});

describe('computeProviderName — global uniqueness against usedNames', () => {
  it('returns the base name when not in usedNames', () => {
    const base = computeProviderName(
      'mcp__serverA__query',
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(base).toBe('mcp_serverA_query');
  });

  it('appends __2 when the base name is already used', () => {
    const used = new Set<string>(['mcp_serverA_query']);
    const out = computeProviderName('mcp__serverA__query', used, AnthropicToolNamePolicy);
    expect(out).toBe('mcp_serverA_query__2');
  });

  it('appends __3 / __4 / __5 … for repeated collisions', () => {
    const used = new Set<string>([
      'mcp_serverA_query',
      'mcp_serverA_query__2',
      'mcp_serverA_query__3',
      'mcp_serverA_query__4',
    ]);
    const out = computeProviderName('mcp__serverA__query', used, AnthropicToolNamePolicy);
    expect(out).toBe('mcp_serverA_query__5');
  });

  it('does NOT mutate the input usedNames set', () => {
    const used = new Set<string>(['mcp_serverA_query']);
    const before = new Set(used);
    computeProviderName('mcp__serverA__query', used, AnthropicToolNamePolicy);
    expect(used).toEqual(before);
  });

  it('does not collide with builtin names that lack the mcp_ prefix', () => {
    // Bash / Read have no mcp_ prefix and so never conflict.
    const used = new Set<string>(['Bash', 'Read', 'Write', 'Glob', 'Grep']);
    const out = computeProviderName('mcp__serverA__bash', used, AnthropicToolNamePolicy);
    expect(out).toBe('mcp_serverA_bash');
  });

  it('matches the canonical example from plan 97 Rev 4.1 §2', () => {
    // The exact case mentioned in the design:
    //   internalKey:  mcp__plugin:com.duya.literature:literature__add_source
    //   providerName: mcp_plugin_com_duya_literature_literature_add_source
    const out = computeProviderName(
      'mcp__plugin:com.duya.literature:literature__add_source',
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out).toBe('mcp_plugin_com_duya_literature_literature_add_source');
    expect(out).toMatch(new RegExp(`^${MCP_PROVIDER_PREFIX}[A-Za-z0-9_-]+$`));
    expect(out.length).toBeLessThanOrEqual(AnthropicToolNamePolicy.maxLength);
  });
});

describe('computeProviderName — length truncation', () => {
  it('keeps the result within policy.maxLength', () => {
    // Build an internal key longer than 64 chars after sanitization.
    const longServer = 'a'.repeat(80);
    const longTool = 'b'.repeat(40);
    const out = computeProviderName(
      `mcp__${longServer}__${longTool}`,
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out.length).toBeLessThanOrEqual(AnthropicToolNamePolicy.maxLength);
  });

  it('falls back to a stable hash-suffixed form when the base + suffix would overflow', () => {
    // Force overflow: 80-char base + '__99' suffix > 64
    const longServer = 'a'.repeat(80);
    const out1 = computeProviderName(
      `mcp__${longServer}__x`,
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out1.length).toBeLessThanOrEqual(AnthropicToolNamePolicy.maxLength);
    expect(out1).toMatch(new RegExp(`^${MCP_PROVIDER_PREFIX}`));
    // Stable: same input → same output
    const out2 = computeProviderName(
      `mcp__${longServer}__x`,
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out2).toBe(out1);
  });

  it('every character of a length-truncated result still matches the policy regex', () => {
    const longServer = 'a'.repeat(80);
    const out = computeProviderName(
      `mcp__${longServer}__x`,
      new Set(),
      AnthropicToolNamePolicy,
    );
    for (const ch of out) {
      expect(ch).toMatch(AnthropicToolNamePolicy.allowedCharRegex);
    }
  });
});

describe('computeProviderName — purity', () => {
  it('returns the same output for the same input + usedNames', () => {
    const a = computeProviderName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      new Set<string>(['Bash', 'Read']),
      AnthropicToolNamePolicy,
    );
    const b = computeProviderName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      new Set<string>(['Bash', 'Read']),
      AnthropicToolNamePolicy,
    );
    expect(a).toBe(b);
  });

  it('treats the input as opaque (does not consult any external state)', () => {
    // Two calls with the same input but different usedNames where
    // neither name is in the set must produce the same base.
    const a = computeProviderName(
      'mcp__serverA__query',
      new Set<string>(['Bash']),
      AnthropicToolNamePolicy,
    );
    const b = computeProviderName(
      'mcp__serverA__query',
      new Set<string>(['Read']),
      AnthropicToolNamePolicy,
    );
    expect(a).toBe(b);
    expect(a).toBe('mcp_serverA_query');
  });
});

describe('computeProviderName — input without mcp__ prefix (defensive)', () => {
  it('still produces a mcp_-prefixed name and treats the input as raw', () => {
    // The engine should only feed keys with the mcp__ prefix. If a
    // caller forgets, the function should still produce a prefixed
    // name (defensive — it does not crash, it does not return a
    // bare sanitized string).
    const out = computeProviderName(
      'plugin:foo__bar',
      new Set(),
      AnthropicToolNamePolicy,
    );
    expect(out.startsWith('mcp_')).toBe(true);
  });
});

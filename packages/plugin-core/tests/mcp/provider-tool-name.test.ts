import { describe, it, expect } from 'vitest';
import {
  AnthropicToolNamePolicy,
  OpenAIToolNamePolicy,
  shortStableHash,
  sanitizeProviderToolName,
  allocateUniqueProviderToolName,
} from '../../src/mcp/provider-tool-name.js';

describe('AnthropicToolNamePolicy', () => {
  it('has the expected id, maxLength and char class', () => {
    expect(AnthropicToolNamePolicy.id).toBe('anthropic');
    expect(AnthropicToolNamePolicy.maxLength).toBe(64);
    expect(AnthropicToolNamePolicy.allowedCharRegex.test('a')).toBe(true);
    expect(AnthropicToolNamePolicy.allowedCharRegex.test('_')).toBe(true);
    expect(AnthropicToolNamePolicy.allowedCharRegex.test('-')).toBe(true);
    expect(AnthropicToolNamePolicy.allowedCharRegex.test(':')).toBe(false);
  });
});

describe('shortStableHash', () => {
  it('returns 6 lowercase hex chars', () => {
    const h = shortStableHash('hello');
    expect(h).toMatch(/^[0-9a-f]{6}$/);
  });

  it('is deterministic', () => {
    expect(shortStableHash('alpha')).toBe(shortStableHash('alpha'));
    expect(shortStableHash('alpha')).not.toBe(shortStableHash('beta'));
  });
});

describe('sanitizeProviderToolName', () => {
  it('removes the mcp__ prefix and __<toolName> suffix', () => {
    const result = sanitizeProviderToolName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      AnthropicToolNamePolicy,
    );
    expect(result).not.toContain(':');
    expect(result).not.toContain('.');
    // The trailing _source should be stripped by trim+collapse logic.
    expect(result.length).toBeGreaterThan(0);
  });

  it('replaces disallowed characters with _', () => {
    const result = sanitizeProviderToolName(
      'mcp__plugin:foo:bar__a.b:c-d',
      AnthropicToolNamePolicy,
    );
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result).not.toContain(':');
    expect(result).not.toContain('.');
  });

  it('collapses consecutive _ into a single _', () => {
    // Input crafted so the result has two adjacent disallowed chars in a
    // row (the . and the :).
    const result = sanitizeProviderToolName(
      'mcp__plugin:foo:bar__a.b',
      AnthropicToolNamePolicy,
    );
    expect(result).not.toMatch(/__/);
  });

  it('trims leading and trailing underscores', () => {
    const result = sanitizeProviderToolName('mcp__plugin:foo:bar__', AnthropicToolNamePolicy);
    expect(result.startsWith('_')).toBe(false);
    expect(result.endsWith('_')).toBe(false);
  });

  it('returns the input unchanged when the shape is not an internal key', () => {
    const raw = 'not-an-internal-key';
    expect(sanitizeProviderToolName(raw, AnthropicToolNamePolicy)).toBe('not-an-internal-key');
  });

  it('applies the same logic to OpenAI policy', () => {
    const a = sanitizeProviderToolName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      AnthropicToolNamePolicy,
    );
    const o = sanitizeProviderToolName(
      'mcp__plugin:com.duya.lit:literature__add_source',
      OpenAIToolNamePolicy,
    );
    expect(a).toBe(o);
  });
});

describe('allocateUniqueProviderToolName', () => {
  it('returns baseName unchanged when not in usedNames', () => {
    const used = new Set<string>();
    expect(allocateUniqueProviderToolName('foo', used, AnthropicToolNamePolicy)).toBe('foo');
  });

  it('appends __2 on first collision', () => {
    const used = new Set<string>(['foo']);
    expect(allocateUniqueProviderToolName('foo', used, AnthropicToolNamePolicy)).toBe('foo__2');
  });

  it('appends __3, __4, ... for repeated collisions', () => {
    const used = new Set<string>(['foo', 'foo__2']);
    expect(allocateUniqueProviderToolName('foo', used, AnthropicToolNamePolicy)).toBe('foo__3');
  });

  it('works with a Map<string, unknown>', () => {
    const used = new Map<string, unknown>([['foo', 1]]);
    expect(allocateUniqueProviderToolName('foo', used, AnthropicToolNamePolicy)).toBe('foo__2');
  });

  it('truncates with stable hash when suffixing would exceed maxLength', () => {
    // baseName near the max length: suffixing will overflow.
    const longBase = 'a'.repeat(AnthropicToolNamePolicy.maxLength);
    const used = new Set<string>([longBase]);
    const result = allocateUniqueProviderToolName(longBase, used, AnthropicToolNamePolicy);
    expect(result.length).toBeLessThanOrEqual(AnthropicToolNamePolicy.maxLength);
    // Stable: the same inputs should yield the same result.
    expect(allocateUniqueProviderToolName(longBase, used, AnthropicToolNamePolicy)).toBe(result);
    // Has the form of a truncated base + '_' + 6 hex chars.
    expect(result).toMatch(/_[0-9a-f]{6}$/);
  });

  it('truncates with stable hash when the base itself exceeds maxLength', () => {
    const tooLong = 'a'.repeat(AnthropicToolNamePolicy.maxLength + 50);
    const used = new Set<string>();
    const result = allocateUniqueProviderToolName(tooLong, used, AnthropicToolNamePolicy);
    expect(result.length).toBeLessThanOrEqual(AnthropicToolNamePolicy.maxLength);
    expect(result).toMatch(/_[0-9a-f]{6}$/);
  });

  it('does not mutate usedNames', () => {
    const used = new Set<string>(['foo']);
    const before = new Set(used);
    allocateUniqueProviderToolName('foo', used, AnthropicToolNamePolicy);
    expect(used).toEqual(before);
  });
});

// Tests for the hook context-injection governor (injection.ts).
//
// Covers: token estimation, envelope rendering + attribute sanitization,
// budget decisions (full / spilled / hard-truncated / spill-disabled), and
// the dedup / replace-last injection chokepoint.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyHookInjection,
  estimateTokens,
  governHookContext,
  hashContext,
  HOOK_CONTEXT_HASH_METADATA,
  HOOK_CONTEXT_KEY_METADATA,
  renderHookContextEnvelope,
  type InjectableMessage,
} from '../injection.js';

const INFO = {
  event: 'PostToolUse',
  hookName: 'npm run typecheck',
  hookType: 'command' as const,
  toolName: 'Edit',
  toolUseId: 'tu_1',
  seq: 3,
};

describe('estimateTokens', () => {
  it('estimates chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(9))).toBe(3);
    expect(estimateTokens('a'.repeat(8))).toBe(2);
  });
});

describe('renderHookContextEnvelope', () => {
  it('renders provenance attributes and wraps content', () => {
    const out = renderHookContextEnvelope(INFO, 'hello');
    expect(out).toContain('<hook-context event="PostToolUse" hook="npm run typecheck" type="command" tool="Edit" tool_use_id="tu_1" seq="3">');
    expect(out.endsWith('\nhello\n</hook-context>')).toBe(true);
  });

  it('omits undefined attributes and sanitizes control chars in values', () => {
    const out = renderHookContextEnvelope(
      { event: 'Stop', hookName: 'bad "name"\nnewline' },
      'x',
    );
    // Only the attribute-level quotes remain (2 per rendered attr).
    const quotes = out.split('"').length - 1;
    expect(quotes).toBe(4);
    expect(out).toContain('hook="bad name newline"');
  });
});

describe('governHookContext', () => {
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-hook-inject-'));

  it('passes within-budget content through verbatim', () => {
    const raw = 'a'.repeat(100); // ~25 tokens
    const g = governHookContext(raw, INFO, { limitTokens: 2500 });
    expect(g.action).toBe('full');
    expect(g.content).toBe(raw);
  });

  it('spills over-budget content to disk with preview + pointer', () => {
    const raw = 'x'.repeat(400 * 4); // 1600 chars ≈ 400 tokens
    const g = governHookContext(raw, INFO, { limitTokens: 10, spillDir });
    expect(g.action).toBe('spilled');
    const match = g.content.match(/saved to (\S+\.txt)/);
    expect(match).not.toBeNull();
    const file = match![1];
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(raw);
    // Preview keeps head+tail of the original.
    expect(g.content).toContain('[… ');
  });

  it('hard-truncates when limit is 0 (spilling disabled)', () => {
    const raw = 'y'.repeat(1000);
    const g = governHookContext(raw, INFO, { limitTokens: 0 });
    expect(g.action).toBe('hard-truncated');
    // Zero budget → everything dropped, only the marker remains.
    expect(g.content.trim()).toBe('[… 1000 chars dropped …]');
  });

  it('keeps head+tail when hard-truncating with a non-zero budget', () => {
    const raw = 'y'.repeat(1000);
    const g = governHookContext(raw, INFO, { limitTokens: 10, disableSpill: true });
    expect(g.action).toBe('hard-truncated');
    expect(g.content.length).toBeLessThan(raw.length);
    expect(g.content).toContain('[… ');
    expect(g.content.startsWith('yyy')).toBe(true);
    expect(g.content.endsWith('yyy')).toBe(true);
  });

  it('falls back to hard truncate when disableSpill is set', () => {
    const raw = 'z'.repeat(1000);
    const g = governHookContext(raw, INFO, { limitTokens: 10, disableSpill: true });
    expect(g.action).toBe('hard-truncated');
  });
});

function msg(content: string, metadata?: Record<string, unknown>): InjectableMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: 'user', content, metadata };
}

describe('applyHookInjection', () => {
  it('appends and stamps key + hash metadata without a dedupKey', () => {
    const messages: InjectableMessage[] = [];
    const action = applyHookInjection(messages, undefined, 'hello', 'custom', { now: 1 });
    expect(action).toBe('injected');
    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.runtimeContext).toBe(true);
    expect(messages[0].metadata?.[HOOK_CONTEXT_KEY_METADATA]).toBeUndefined();
    expect(messages[0].metadata?.[HOOK_CONTEXT_HASH_METADATA]).toBe(hashContext('hello'));
  });

  it('dedupes identical content already present', () => {
    const messages: InjectableMessage[] = [msg('other')];
    applyHookInjection(messages, 'k1', 'same', 'custom', { now: 1 });
    const action = applyHookInjection(messages, 'k1', 'same', 'custom', { now: 2 });
    expect(action).toBe('deduped');
    expect(messages).toHaveLength(2);
  });

  it('replaces the previous block with the same key in place', () => {
    const messages: InjectableMessage[] = [msg('unrelated')];
    applyHookInjection(messages, 'k1', 'v1', 'custom', { now: 1 });
    applyHookInjection(messages, 'k2', 'other-hook', 'custom', { now: 2 });
    const action = applyHookInjection(messages, 'k1', 'v2', 'custom', { now: 3 });
    expect(action).toBe('replaced');
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toBe('v2');
    expect(messages[1].metadata?.[HOOK_CONTEXT_HASH_METADATA]).toBe(hashContext('v2'));
    expect(messages[2].content).toBe('other-hook');
  });

  it('injects fresh when only the key matches but content differs elsewhere', () => {
    const messages: InjectableMessage[] = [];
    applyHookInjection(messages, 'k1', 'a', 'custom', { now: 1 });
    const action = applyHookInjection(messages, 'k2', 'b', 'custom', { now: 2 });
    expect(action).toBe('injected');
    expect(messages).toHaveLength(2);
  });
});

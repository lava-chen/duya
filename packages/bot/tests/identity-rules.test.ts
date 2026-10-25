/**
 * The pure identity rules (framework plan S2).
 *
 * These pin what S1's Host code owned, now domain-owned: id slugging and
 * allocation with an INJECTED suffix (no node:crypto here), the upsert
 * preserve rules, the identity-patch semantics, and the canonical view that
 * merges the runtime profile over the config entry.
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_ID_PATTERN,
  allocateBotId,
  applyIdentityPatch,
  assertValidBotId,
  buildUpsertedAgent,
  canonicalBotRecord,
  findInvalidBotIds,
  isSafeBotId,
  isSoftDeletedConfigAgent,
  slugifyBotIdFromName,
} from '../src/index.js';

describe('bot id rules', () => {
  it('accepts kebab-case slugs and rejects path-escape shapes', () => {
    expect(BOT_ID_PATTERN.test('frontend-expert')).toBe(true);
    expect(BOT_ID_PATTERN.test('a')).toBe(true);
    expect(isSafeBotId('../evil')).toBe(false);
    expect(isSafeBotId('has.dot')).toBe(false);
    expect(isSafeBotId('UPPER')).toBe(false);
    expect(isSafeBotId(42)).toBe(false);
    expect(() => assertValidBotId('..%2f')).toThrow(/Invalid bot id/);
  });

  it('reports invalid existing config keys instead of throwing', () => {
    expect(findInvalidBotIds(['ok-id', 'bad.id', 7, 'fine'])).toEqual(['bad.id', '7']);
  });

  it('slugifies names; short and non-ASCII names fall back to the generic base', () => {
    expect(slugifyBotIdFromName('  Frontend Expert! ')).toBe('frontend-expert');
    expect(slugifyBotIdFromName('前端的专家')).toBe('bot');
    expect(slugifyBotIdFromName('x')).toBe('bot');
  });

  it('allocates the desired id when free and appends the INJECTED suffix on collision', () => {
    const taken = new Set(['frontend-expert', 'frontend-expert-aaa000']);
    const suffixes = ['aaa000', 'bbb111'];
    expect(allocateBotId('frontend-expert', taken, () => suffixes.shift()!)).toBe('frontend-expert-bbb111');
    expect(allocateBotId('fresh-bot', new Set(), () => 'never')).toBe('fresh-bot');
  });

  it('truncates the base to keep the worst case inside the 63-char limit', () => {
    const long = 'a'.repeat(60);
    const id = allocateBotId(long, new Set([long]), () => 'c0ffee');
    expect(id).toBe(`${'a'.repeat(48)}-c0ffee`);
    expect(isSafeBotId(id)).toBe(true);
  });

  it('gives up after 100 attempts instead of looping forever', () => {
    const long = 'a'.repeat(48);
    const taken = new Set<string>([long]);
    for (let i = 0; i < 100; i++) taken.add(`${long}-${i.toString(16).padStart(6, '0')}`);
    let n = 0;
    expect(() =>
      allocateBotId(long, taken, () => (n++).toString(16).padStart(6, '0')),
    ).toThrow(/could not allocate a unique bot id/);
  });
});

describe('upsert merge rules', () => {
  it('replaces the input fields and preserves provider / reasoning / prompt', () => {
    const existing = {
      name: 'Old',
      provider: 'anthropic',
      reasoning: 'high' as const,
      prompt: { sections: { enable: ['a'] } },
      tools: { allow: ['file:*'] },
      plugins: ['mcp:github'],
    };
    const next = buildUpsertedAgent(existing, { name: '  New  ' });
    expect(next).toMatchObject({
      name: 'New',
      provider: 'anthropic',
      reasoning: 'high',
      prompt: { sections: { enable: ['a'] } },
    });
    // tools / plugins only survive when the INPUT carries them.
    expect(next.tools).toBeUndefined();
    expect(next.plugins).toBeUndefined();
  });

  it('keeps tools and plugins only when the input carries a non-empty set', () => {
    const next = buildUpsertedAgent(undefined, {
      name: 'N',
      tools: { allow: ['file:*'] },
      plugins: ['mcp:x'],
    });
    expect(next.tools).toEqual({ allow: ['file:*'] });
    expect(next.plugins).toEqual(['mcp:x']);
  });

  it('requires a non-empty name', () => {
    expect(() => buildUpsertedAgent(undefined, { name: '   ' })).toThrow(/name is required/);
  });
});

describe('identity patch and the canonical view', () => {
  it('changes only patched non-empty fields and sets the revision authority', () => {
    const existing = buildUpsertedAgent(undefined, {
      name: 'A',
      description: 'first',
      model: 'm',
    });
    const patched = applyIdentityPatch(existing, { name: 'B', description: '   ' }, 7);
    expect(patched).toMatchObject({ name: 'B', description: 'first', model: 'm', revision: 7 });
  });

  it('merges profile.json over the config entry, id last', () => {
    const entry = { name: 'Config Name', description: 'config desc', revision: 3 };
    expect(canonicalBotRecord('b', entry, { name: 'Runtime Name', title: 'The Role', description: 'runtime desc' })).toEqual({
      id: 'b',
      name: 'Runtime Name',
      title: 'The Role',
      description: 'runtime desc',
      revision: 3,
    });
    expect(canonicalBotRecord('b', entry, null)).toEqual({
      id: 'b', name: 'Config Name', title: '', description: 'config desc', revision: 3,
    });
    expect(canonicalBotRecord('b', undefined, null)).toBeNull();
  });

  it('hides soft-deleted entries from the canonical view', () => {
    expect(isSoftDeletedConfigAgent({ deleted_at: 123 })).toBe(true);
    expect(isSoftDeletedConfigAgent({ deleted_at: null })).toBe(false);
    expect(isSoftDeletedConfigAgent(undefined)).toBe(false);
    expect(canonicalBotRecord('b', { name: 'Gone', deleted_at: 5 }, null)).toBeNull();
  });
});

/**
 * contextual-user-fragment.ts — unit tests.
 *
 * Covers: marker wrapping, role/kind immutability, renderFragment
 * type contract, isContextualFragment detection, renderFragments
 * concatenation, matcher registration.
 *
 * Plan 453 Task C1.
 */

import { describe, it, expect } from 'vitest';

import {
  CONTEXTUAL_USER_FRAGMENT_MATCHERS,
  isContextualFragment,
  renderFragment,
  renderFragments,
  type ContextualUserFragment,
} from '../contextual-user-fragment.js';

const sampleFragment: ContextualUserFragment = {
  role: () => 'user',
  contentKind: () => 'foo',
  markers: () => ['<external_foo>', '</external_foo>'] as const,
  body: () => 'hello world',
  matchesText: (text: string) => text.includes('hello'),
};

describe('renderFragment', () => {
  it('wraps body() in markers()', () => {
    const block = renderFragment(sampleFragment);
    expect(block.type).toBe('text');
    expect(block.text).toBe('<external_foo>\nhello world\n</external_foo>');
  });

  it('produces a TextContent block', () => {
    const block = renderFragment(sampleFragment);
    // Satisfies the MessageContent union member.
    expect(block).toEqual({ type: 'text', text: expect.any(String) });
  });
});

describe('isContextualFragment', () => {
  const block = renderFragment(sampleFragment);

  it('detects blocks that match the expected kind', () => {
    expect(isContextualFragment(block, 'foo')).toBe(true);
  });

  it('rejects blocks of a different kind', () => {
    expect(isContextualFragment(block, 'bar')).toBe(false);
  });

  it('detects any external_* fragment when no kind specified', () => {
    expect(isContextualFragment(block)).toBe(true);
  });

  it('rejects plain text blocks', () => {
    const plain = { type: 'text' as const, text: 'just a message' };
    expect(isContextualFragment(plain)).toBe(false);
  });

  it('rejects non-text blocks', () => {
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png',
        data: 'abc',
      },
    };
    expect(isContextualFragment(image)).toBe(false);
  });
});

describe('renderFragments', () => {
  it('concatenates multiple fragments with markers preserved', () => {
    const frag1: ContextualUserFragment = {
      role: () => 'user',
      contentKind: () => 'a',
      markers: () => ['<external_a>', '</external_a>'] as const,
      body: () => 'one',
    };
    const frag2: ContextualUserFragment = {
      role: () => 'user',
      contentKind: () => 'b',
      markers: () => ['<external_b>', '</external_b>'] as const,
      body: () => 'two',
    };
    const block = renderFragments([frag1, frag2]);
    expect(block.type).toBe('text');
    expect(block.text).toContain('<external_a>');
    expect(block.text).toContain('<external_b>');
    expect(block.text).toContain('one');
    expect(block.text).toContain('two');
  });

  it('renders an empty list as an empty text block', () => {
    const block = renderFragments([]);
    expect(block).toEqual({ type: 'text', text: '' });
  });
});

describe('CONTEXTUAL_USER_FRAGMENT_MATCHERS', () => {
  it('exposes a mutable array', () => {
    expect(Array.isArray(CONTEXTUAL_USER_FRAGMENT_MATCHERS)).toBe(true);
    const len = CONTEXTUAL_USER_FRAGMENT_MATCHERS.length;
    const matcher = (): boolean => false;
    CONTEXTUAL_USER_FRAGMENT_MATCHERS.push(matcher);
    expect(CONTEXTUAL_USER_FRAGMENT_MATCHERS.length).toBe(len + 1);
    CONTEXTUAL_USER_FRAGMENT_MATCHERS.pop();
    expect(CONTEXTUAL_USER_FRAGMENT_MATCHERS.length).toBe(len);
  });
});
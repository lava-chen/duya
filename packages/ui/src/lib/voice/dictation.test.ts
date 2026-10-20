import { describe, it, expect } from 'vitest';
import { applyDictation } from './dictation';

describe('applyDictation (append semantics)', () => {
  it('shows interim as base + interim without committing to the base', () => {
    let base = 'hello';
    const interim = applyDictation(base, ' wo', 'interim');
    expect(interim.display).toBe('hello wo');
    // Base is unchanged for interim.
    expect(interim.base).toBe('hello');
  });

  it('commits a final result onto the base with a single-space join', () => {
    const base = 'hello';
    const final = applyDictation(base, 'world', 'final');
    expect(final.display).toBe('hello world ');
    expect(final.base).toBe('hello world ');
  });

  it('does not double the separator when the base already ends with a space', () => {
    const base = 'hello ';
    const final = applyDictation(base, 'world', 'final');
    expect(final.display).toBe('hello world ');
    expect(final.base).toBe('hello world ');
  });

  it('starts clean when the base is empty', () => {
    const final = applyDictation('', 'first', 'final');
    expect(final.display).toBe('first ');
    expect(final.base).toBe('first ');
  });

  it('ignores an empty/whitespace final result', () => {
    const base = 'hello';
    const final = applyDictation(base, '   ', 'final');
    expect(final.display).toBe('hello');
    expect(final.base).toBe('hello');
  });

  it('supports consecutive finals that append to the growing base', () => {
    let state = applyDictation('', 'one', 'final');
    state = applyDictation(state.base, 'two', 'final');
    state = applyDictation(state.base, 'three', 'final');
    expect(state.display).toBe('one two three ');
    expect(state.base).toBe('one two three ');
  });
});
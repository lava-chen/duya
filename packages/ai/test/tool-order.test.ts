import { describe, expect, it } from 'vitest';
import { sortToolsByName } from '../src/utils/tool-order.js';

describe('sortToolsByName', () => {
  it('sorts tools by name in byte order', () => {
    const tools = [
      { name: 'zebra', description: 'z' },
      { name: 'alpha', description: 'a' },
      { name: 'mike', description: 'm' },
    ];
    expect(sortToolsByName(tools).map(t => t.name)).toEqual(['alpha', 'mike', 'zebra']);
  });

  it('produces the identical order for the same set regardless of input order (cache stability)', () => {
    const a = [{ name: 'b', description: 'x' }, { name: 'a', description: 'x' }, { name: 'c', description: 'x' }];
    const b = [{ name: 'c', description: 'x' }, { name: 'b', description: 'x' }, { name: 'a', description: 'x' }];
    expect(sortToolsByName(a).map(t => t.name)).toEqual(sortToolsByName(b).map(t => t.name));
  });

  it('does not mutate the input array', () => {
    const tools = [{ name: 'b' }, { name: 'a' }, { name: 'c' }];
    const snapshot = [...tools];
    sortToolsByName(tools);
    expect(tools.map(t => t.name)).toEqual(snapshot.map(t => t.name));
  });

  it('returns an empty array for empty input', () => {
    expect(sortToolsByName([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { BoundedIdSet } from './dedup.js';

describe('BoundedIdSet', () => {
  it('reports the first sighting as new and the second as duplicate', () => {
    const set = new BoundedIdSet();
    expect(set.add('a')).toBe(true);
    expect(set.add('a')).toBe(false);
    expect(set.has('a')).toBe(true);
  });

  it('evicts FIFO once the capacity is exceeded', () => {
    const set = new BoundedIdSet({ capacity: 3 });
    set.add('a');
    set.add('b');
    set.add('c');
    set.add('d');

    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.has('d')).toBe(true);
  });

  it('keeps a re-added id from evicting itself', () => {
    const set = new BoundedIdSet({ capacity: 2 });
    set.add('a');
    set.add('b');
    expect(set.add('a')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('expires entries after the TTL using the injected clock', () => {
    let now = 0;
    const set = new BoundedIdSet({ capacity: 10, ttlMs: 1000, now: () => now });
    expect(set.add('a')).toBe(true);

    now = 500;
    expect(set.has('a')).toBe(true);

    now = 1500;
    expect(set.has('a')).toBe(false);
    // An expired id is accepted again (replay after TTL).
    expect(set.add('a')).toBe(true);
  });

  it('isDuplicate mirrors add() without a second lookup', () => {
    const set = new BoundedIdSet();
    expect(set.isDuplicate('x')).toBe(false);
    expect(set.isDuplicate('x')).toBe(true);
  });

  it('clear() removes everything', () => {
    const set = new BoundedIdSet();
    set.add('a');
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has('a')).toBe(false);
  });
});

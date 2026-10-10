import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyFilter, filterItemsFuzzy } from '../src/index.js';

/**
 * The fuzzy matcher, which is genuinely new code rather than moved code.
 *
 * That distinction matters for how these tests are written. `input-completion.test.ts`
 * guards a port and can lean on the desktop suite; these have no prior
 * implementation to lean on, so each case has to justify the behaviour on its
 * own terms.
 */

describe('fuzzyMatch', () => {
  it('matches an in-order subsequence', () => {
    // useApp: u(0) s(1) e(2) A(3) p(4) p(5) — so `uapp` hits 0,3,4,5.
    const result = fuzzyMatch('useApp', 'uapp');
    expect(result).not.toBeNull();
    expect(result?.indices).toEqual([0, 3, 4, 5]);
  });

  it('REJECTS out-of-order characters — the cursor never resets', () => {
    // This is the rule that makes the result rankable rather than boolean, and
    // it is not obvious from the name. `useApp` does not contain `apu` in order.
    expect(fuzzyMatch('useApp', 'apu')).toBeNull();
  });

  it('is case-insensitive but reports indices into the original haystack', () => {
    const result = fuzzyMatch('UseApp', 'uapp');
    expect(result?.indices).toEqual([0, 3, 4, 5]);
  });

  it('matches an empty needle with no indices', () => {
    // So an empty filter is a no-op rather than a special case everywhere.
    expect(fuzzyMatch('anything', '')).toEqual({ indices: [], score: 0 });
  });

  it('scores a prefix match better than a scattered one', () => {
    const prefix = fuzzyMatch('useApp', 'use');
    const scattered = fuzzyMatch('userAccountPanel', 'usap');
    expect(prefix?.score).toBeLessThan(scattered?.score ?? 0);
  });

  it('scores consecutive characters better than gapped ones', () => {
    const together = fuzzyMatch('abc', 'abc');
    const apart = fuzzyMatch('axxxbxxxc', 'abc');
    expect(together?.score).toBeLessThan(apart?.score ?? 0);
  });

  it('scores an exact match best of all', () => {
    const exact = fuzzyMatch('doctor', 'doctor');
    const partial = fuzzyMatch('doctors', 'doctor');
    expect(exact?.score).toBeLessThan(partial?.score ?? 0);
  });

  it('reports every character for an exact astral match', () => {
    // Offsets must be UTF-16 and cover both surrogate halves, or a renderer
    // highlighting the hit would underline half a code point.
    const result = fuzzyMatch('👋👋', '👋👋');
    expect(result?.indices).toEqual([0, 2]);
  });

  it('treats a separator as a good place to match', () => {
    // `src/app/useApp.ts`: matching the `u` right after the slash earns the
    // boundary bonus; matching a `u` buried mid-token does not. Both needles
    // are the same letters, so only the position can explain the difference.
    const atBoundary = fuzzyMatch('src/app/useApp.ts', 'use');
    const buried = fuzzyMatch('src/xxuuseApp.ts', 'use');
    expect(atBoundary?.score).toBeLessThan(buried?.score ?? 0);
  });

  it('finds a path a substring filter could not', () => {
    // The reason this package ships a matcher at all. No contiguous run of
    // `src/uA` exists in `src/app/useApp.ts`.
    expect('src/app/useApp.ts'.includes('src/uA')).toBe(false);
    expect(fuzzyMatch('src/app/useApp.ts', 'src/uA')).not.toBeNull();
  });

  it('matches CJK one character at a time', () => {
    // Iterating UTF-16 units would let a surrogate half match and split the
    // highlight; code points are the unit a reader perceives.
    // 审查代码变更: 审(0) 查(1) 代(2) 码(3) 变(4) 更(5).
    const result = fuzzyMatch('审查代码变更', '代码');
    expect(result?.indices).toEqual([2, 3]);
  });

  it('matches an astral character, not just the BMP', () => {
    // The obvious implementation compares one UTF-16 unit against a whole code
    // point, which works for CJK and returns null for everything outside the
    // BMP — so a label containing an emoji could never be completed. The
    // transcript renders emoji, so they do appear in labels.
    const result = fuzzyMatch('run 👋 now', 'now');
    expect(result?.indices).toEqual([7, 8, 9]);
    expect(fuzzyMatch('a👋b', '👋')).not.toBeNull();
  });
});

describe('fuzzyFilter', () => {
  const items = ['useApp', 'useAppRouter', 'unrelated', 'appConfig'];

  it('drops non-matches', () => {
    expect(fuzzyFilter(items, 'useapp')).toEqual(['useApp', 'useAppRouter']);
  });

  it('ranks the best match first', () => {
    expect(fuzzyFilter(items, 'useapp')[0]).toBe('useApp');
  });

  it('is stable for equal scores, so a selection cannot shuffle on re-render', () => {
    const tied = ['b', 'a', 'c'];
    // Same scores; input order must survive, or the highlighted row appears to
    // move by itself every keystroke.
    expect(fuzzyFilter(tied, '')).toEqual(['b', 'a', 'c']);
    expect(fuzzyFilter(['xxa', 'xxb', 'xxc'], 'xx')).toEqual(['xxa', 'xxb', 'xxc']);
  });

  it('returns everything for an empty query, in input order', () => {
    expect(fuzzyFilter(items, '')).toEqual(items);
  });
});

describe('filterItemsFuzzy', () => {
  it('ranks by label by default, and a Chinese label is matchable', () => {
    const found = filterItemsFuzzy(
      [
        { label: '诊断项目问题', value: '/doctor' },
        { label: '审查代码变更', value: '/review' },
      ],
      '审查',
    );
    expect(found[0]?.value).toBe('/review');
  });

  it('drops labels the query cannot reach in order', () => {
    // `rev` is not an in-order subsequence of `诊断项目问题`, so it must not
    // match even though it shares no characters at all.
    const found = filterItemsFuzzy([{ label: '诊断项目问题', value: '/doctor' }], 'rev');
    expect(found).toEqual([]);
  });

  it('can be pointed at another field', () => {
    const found = filterItemsFuzzy(
      [
        { label: 'alpha', value: '/alpha' },
        { label: 'beta', value: '/beta' },
      ],
      'a',
      (item) => item.value,
    );
    // Both contain `a` in order; `/alpha` has it first and wins on score.
    expect(found.map((i) => i.value)).toEqual(['/alpha', '/beta']);
  });
});
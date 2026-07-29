import { describe, expect, it } from 'vitest';
import { collapseContextLines, parseUnifiedDiff, toSplitRows } from './code-review-diff';

const PATCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 123..456 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -4,5 +4,6 @@ export function example() {',
  ' const before = true;',
  '-  return before;',
  '+  const after = before;',
  '+  return after;',
  ' }',
  '',
].join('\n');

describe('code review diff parsing', () => {
  it('preserves hunk line numbers and change kinds', () => {
    const [hunk] = parseUnifiedDiff(PATCH);

    expect(hunk.header).toContain('-4,5 +4,6');
    expect(hunk.lines).toEqual([
      { type: 'context', content: 'const before = true;', oldLineNumber: 4, newLineNumber: 4 },
      { type: 'remove', content: '  return before;', oldLineNumber: 5 },
      { type: 'add', content: '  const after = before;', newLineNumber: 5 },
      { type: 'add', content: '  return after;', newLineNumber: 6 },
      { type: 'context', content: '}', oldLineNumber: 6, newLineNumber: 7 },
    ]);
  });

  it('pairs changed runs and collapses only long unchanged ranges', () => {
    const [hunk] = parseUnifiedDiff(PATCH);
    const split = toSplitRows(hunk.lines);

    expect(split[1]).toEqual({
      type: 'line',
      oldLine: { type: 'remove', content: '  return before;', oldLineNumber: 5 },
      newLine: { type: 'add', content: '  const after = before;', newLineNumber: 5 },
    });
    expect(split[2]).toEqual({
      type: 'line',
      oldLine: undefined,
      newLine: { type: 'add', content: '  return after;', newLineNumber: 6 },
    });

    const longContext = Array.from({ length: 9 }, (_, index) => ({
      type: 'context' as const,
      content: `line ${index + 1}`,
      oldLineNumber: index + 1,
      newLineNumber: index + 1,
    }));
    expect(collapseContextLines(longContext, true)).toHaveLength(7);
    expect(collapseContextLines(longContext, true)[3]).toEqual({ type: 'collapsed', count: 3 });
  });
});

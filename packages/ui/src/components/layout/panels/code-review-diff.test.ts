import { describe, expect, it } from 'vitest';
import {
  countPatchChanges,
  fileLanguageLabel,
  parseReviewPatch,
  parseUnifiedDiff,
} from './code-review-diff';

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

  it('counts per-file additions and removals from parsed hunks', () => {
    const [filePatch] = parseReviewPatch(PATCH);
    expect(countPatchChanges(filePatch.hunks)).toEqual({ additions: 2, removals: 1 });
    expect(countPatchChanges([])).toEqual({ additions: 0, removals: 0 });
  });

  it('keeps the verbatim per-file patch for the diff renderer', () => {
    const [filePatch] = parseReviewPatch(PATCH);
    expect(filePatch.raw).toBe(PATCH);

    const multi = [
      PATCH,
      'diff --git a/src/other.ts b/src/other.ts',
      '--- a/src/other.ts',
      '+++ b/src/other.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const files = parseReviewPatch(multi);
    expect(files).toHaveLength(2);
    expect(files[0].raw).toBe(PATCH);
    expect(files[1].raw).toBe([
      'diff --git a/src/other.ts b/src/other.ts',
      '--- a/src/other.ts',
      '+++ b/src/other.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n'));
  });

  it('maps file extensions to short language badges', () => {
    expect(fileLanguageLabel('src/app/components/Panel.tsx')).toBe('TSX');
    expect(fileLanguageLabel('docs/README.MD')).toBe('MD');
    expect(fileLanguageLabel('styles/theme.scss')).toBe('SCSS');
    expect(fileLanguageLabel('Makefile')).toBeNull();
    expect(fileLanguageLabel('assets/logo.xyz')).toBeNull();
  });
});

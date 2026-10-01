/**
 * check-no-ts-suppress.test.ts — regression tests for the suppression gate.
 *
 * The gate exists because `@ts-nocheck` is invisible: it does not fail the
 * build, does not fail `npm run`, and looks like an ordinary comment in
 * review. What actually broke while it was in place was a single import of
 * a type that had not existed for a long time, so these tests pin the
 * classification rules rather than the exit code.
 */
import { describe, expect, it } from 'vitest';

import { findSuppressions } from './check-no-ts-suppress.mjs';

describe('findSuppressions', () => {
  it('reports nothing for ordinary source', () => {
    const text = [
      "import { useState } from 'react';",
      '',
      'export function useThing() {',
      '  return useState(0);',
      '}',
    ].join('\n');
    expect(findSuppressions(text)).toEqual([]);
  });

  it('classifies the three directives', () => {
    const text = [
      '// @ts-nocheck',
      '// @ts-ignore - jimp ships no usable types',
      '// @ts-expect-error - intentional runtime mutation',
    ].join('\n');
    expect(findSuppressions(text)).toEqual([
      { kind: 'nocheck', line: 1, text: '// @ts-nocheck' },
      { kind: 'ignore', line: 2, text: '// @ts-ignore - jimp ships no usable types' },
      { kind: 'expect-error', line: 3, text: '// @ts-expect-error - intentional runtime mutation' },
    ]);
  });

  it('finds a directive that is not the first line of the file', () => {
    // This is the shape that actually shipped: four Feishu adapter files
    // whose `@ts-nocheck` sat above a normal-looking doc comment.
    const text = [
      '/**',
      ' * Feishu Document Comment Handler',
      ' */',
      '',
      '// @ts-nocheck',
      "import { FeishuEvent } from './types.js';",
    ].join('\n');
    expect(findSuppressions(text)).toEqual([
      { kind: 'nocheck', line: 5, text: '// @ts-nocheck' },
    ]);
  });

  it('reports the first matching directive per line, not several', () => {
    // `@ts-expect-error` contains the substring "expect-error"; a naive
    // scan would double-count a line that mentions two directives.
    const text = '// @ts-nocheck (was: @ts-expect-error)';
    expect(findSuppressions(text)).toEqual([
      { kind: 'nocheck', line: 1, text: '// @ts-nocheck (was: @ts-expect-error)' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const text = '// @ts-nocheck\r\nconst a = 1;\r\n// @ts-ignore\r\n';
    expect(findSuppressions(text).map((h) => [h.kind, h.line])).toEqual([
      ['nocheck', 1],
      ['ignore', 3],
    ]);
  });

  it('sees a directive that is not in a comment at all', () => {
    // The gate scans raw text, not the AST, because a directive only takes
    // effect where it physically sits. A string literal that happens to
    // contain the token is still reported — that is a false positive we
    // accept rather than a hole, because the alternative is parsing.
    const text = 'const note = "use @ts-nocheck sparingly";';
    expect(findSuppressions(text)).toEqual([
      { kind: 'nocheck', line: 1, text: 'const note = "use @ts-nocheck sparingly";' },
    ]);
  });
});

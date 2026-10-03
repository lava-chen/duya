/**
 * The comment stripper the two audit scripts depend on.
 *
 * ## Why this needs its own test
 *
 * `stripComments` gates a governance gate. If it blanks a string, an import
 * edge disappears from the audit and a real violation goes unreported — a
 * silent under-count, the worst failure mode this repo has. If it leaves a
 * comment alone, a doc comment reads as an import and the baseline inflates.
 * Both directions are invisible unless something checks.
 *
 * So the assertions below are mostly about what the stripper must NOT touch:
 * string contents, regex literals, line numbers.
 */

import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments.mjs';

/**
 * The same edge regex both audit scripts use.
 *
 * CR and LF are excluded: a specifier is never multi-line, and letting the
 * class match line endings let a match begin inside ordinary code and run to a
 * quote many lines later. `strip-comments.test.ts` asserts that below.
 */
const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g;

function liveSpecs(src: string): string[] {
  const { text, unterminated } = stripComments(src);
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(unterminated ? src : text))) out.push(m[1]!);
  return out;
}

describe('strip-comments: comments are not code', () => {
  it('ignores a doc comment that quotes the import syntax', () => {
    // The exact false positive that motivated this file: drift test #2
    // documents its own regex as ``from '...'`` and was reported as three
    // `UNRESOLVED:...` module-dependency violations.
    const src = "/** Matches `from '...'`, `import('...')` and `require('...')`. */\nimport x from './a.js';";
    expect(liveSpecs(src)).toEqual(['./a.js']);
  });

  it('a commented-out import is not an edge', () => {
    // The under-count direction, and the reason this is not a lint. If this
    // were counted, deleting the comment would look like removing a violation.
    expect(liveSpecs("// import x from './gone.js';\nimport y from './real.js';")).toEqual([
      './real.js',
    ]);
    expect(liveSpecs("/* import z from './nope.js'; */\nimport y from './real.js';")).toEqual([
      './real.js',
    ]);
  });

  it('handles a JSDoc block containing quotes, braces and an example', () => {
    const src = "/**\n * @example\n *   from 'x'\n */\nimport y from './r.js';";
    expect(liveSpecs(src)).toEqual(['./r.js']);
  });
});

describe('strip-comments: strings and regexes are not comments', () => {
  it('does not let a // inside a string start a comment', () => {
    // The import on the next line surviving IS the assertion: if the string's
    // `//` had opened a comment, everything after it would be blanked.
    expect(liveSpecs("const u = 'https://x.dev/a';\nimport y from './real.js';")).toEqual([
      './real.js',
    ]);
    expect(liveSpecs('const s = "a // b";\nimport y from "./r.js";')).toEqual(['./r.js']);
  });

  it('does not let a /* inside a string start a block comment', () => {
    expect(liveSpecs("const s = 'a /* b';\nimport y from './r.js';")).toEqual(['./r.js']);
  });

  it('keeps an escaped slash inside a regex literal intact', () => {
    expect(liveSpecs("const re = /a\\/\\/b/;\nimport y from './r.js';")).toEqual(['./r.js']);
  });

  it('does not mistake division for a regex', () => {
    expect(liveSpecs('const q = a / b;\nimport y from "./r.js";')).toEqual(['./r.js']);
  });

  it('treats a template literal as opaque', () => {
    // Documented limit: `${...}` interpolation is not scanned for comments.
    // It cannot produce a false edge, because the interpolation's text is
    // preserved rather than duplicated.
    expect(liveSpecs('const t = `x ${1 + 1} y`;\nimport y from "./r.js";')).toEqual(['./r.js']);
  });
});

describe('strip-comments: diagnostics and offsets', () => {
  it('preserves line numbers so violation messages stay truthful', () => {
    const src = "a\n// c\nb\n/* x\ny */\nc\nconst q = 1;\n";
    const { text } = stripComments(src);
    expect(text.split('\n')).toHaveLength(src.split('\n').length);
    // A live import's line index must be unchanged after stripping.
    const withImport = "// lead\n/* two */\nimport y from './r.js';\n";
    const stripped = stripComments(withImport).text;
    expect(stripped.split('\n')[2]).toContain("'./r.js'");
  });

  it('reports an unterminated construct so the caller can fall back', () => {
    expect(stripComments('/* never closed').unterminated).toBe(true);
    expect(stripComments("const s = 'oops\n").unterminated).toBe(true);
    expect(stripComments("const s = 'fine';\n").unterminated).toBe(false);
  });

  it('ends a block comment at the first */', () => {
    expect(liveSpecs("/* a */ import y from './r.js';")).toEqual(['./r.js']);
  });
});

describe('strip-comments: an import specifier is never multi-line', () => {
  /**
   * The real shape, lifted from
   * `apps/desktop/src/renderer/components/layout/panels/code-review-diff.ts`.
   *
   * The string literal `'rename from '` contains the sequence `from `, so the
   * regex took that for its keyword and opened the capture on that string's
   * closing quote. Because the specifier class was `[^"']` — which matches CR
   * and LF — the capture then ran to the next quote anywhere in the file and
   * swallowed two lines of ordinary source. `.length);\n    else if
   * (line.startsWith(` was reported as an `UNRESOLVED:` module-dependency
   * violation. And because the capture held the RAW line ending, that junk
   * fingerprinted differently on a CRLF and an LF checkout: green on Windows,
   * one new blocking violation on ubuntu. Same code, opposite verdict.
   */
  const QUOTE_THEN_QUOTE_LATER = [
    "    else if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length);",
    "    else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);",
  ].join('\n');

  it('never captures a specifier that spans a line break', () => {
    for (const src of [QUOTE_THEN_QUOTE_LATER, QUOTE_THEN_QUOTE_LATER.replace(/\n/g, '\r\n')]) {
      for (const spec of liveSpecs(src)) {
        expect(spec).not.toMatch(/[\r\n]/);
      }
    }
  });

  it('produces identical specifiers for CRLF and LF source', () => {
    // The platform-independence half of the defect. Identical code must yield
    // identical fingerprints, or one recorded baseline cannot be valid on
    // every OS — which is what made the `architecture` CI job unstable.
    const lf = `${QUOTE_THEN_QUOTE_LATER}\nimport y from './r.js';`;
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(liveSpecs(crlf)).toEqual(liveSpecs(lf));
  });

  it('still reports the real import, so the junk fix did not blind the gate', () => {
    // The under-count direction, and the reason this is not "just delete the
    // bad match": a regex tightened to stop spanning lines must keep seeing
    // the imports that are genuinely there.
    const lf = `${QUOTE_THEN_QUOTE_LATER}\nimport y from './r.js';`;
    expect(liveSpecs(lf)).toContain('./r.js');
    expect(liveSpecs(lf.replace(/\n/g, '\r\n'))).toContain('./r.js');
  });
});

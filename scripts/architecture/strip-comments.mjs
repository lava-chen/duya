#!/usr/bin/env node
/**
 * Strip JS/TS comments, preserving byte offsets.
 *
 * ## Why this file exists
 *
 * Both audit scripts find import edges with a regex over the raw file text.
 * A regex cannot tell code from prose, so a doc comment that says
 * `from '...'` reads as an import edge. That happened for real, twice:
 *
 *  - `audit-imports.mjs` carried a `SKIP_SPEC` band-aid — literally
 *    `[".length);", "else if (line.startsWith("]` — two specifiers someone hit
 *    and patched by name. A gate patched by listing the strings it mis-parses
 *    is a gate with a hole and no alarm on it.
 *  - `packages/agent-protocol/test/02-cycle-budget.test.ts` documents its own
 *    regex as ``from '...'`` / ``import('...')`` / ``require('...')`` and was
 *    reported as three `UNRESOLVED:...` module-dependency violations.
 *
 * The error goes both ways and both directions are bad. Over-counting files a
 * comment as an import inflates the baseline. UNDER-counting is worse: a
 * commented-out `import { x } from '../foo'` is still counted as a live edge,
 * so deleting the comment would look like it removed a violation. A governance
 * gate must only ever see code.
 *
 * ## Offsets are preserved
 *
 * Replaced comment characters become spaces (newlines stay newlines), so a
 * line number computed from the stripped text matches the original file. That
 * matters: every violation message points at a file and a line, and a gate
 * whose line numbers are fiction is a gate nobody trusts.
 *
 * ## The one heuristic, and why it errs the safe way
 *
 * A `/` is a regex-literal start or a division operator, and telling them apart
 * needs the previous token. When the answer is ambiguous this scanner assumes
 * DIVISION, i.e. it keeps scanning the contents as code.
 *
 * That direction is chosen deliberately. Assuming "division" can only cause a
 * missed comment start, and a comment start requires a bare `//` or `/*`,
 * neither of which can legally appear unescaped inside a regex literal (`/` must
 * be escaped there). The opposite assumption could swallow a real import and
 * silently drop a violation. `unterminated` is reported so the caller can fall
 * back to the raw text rather than ship a half-stripped file.
 */

const DIVISION_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*",
  "%", "~", "^", "<", ">", ")", "\n",
]);

/** Words after which a `/` must be a regex, never division. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

/**
 * @param {string} src
 * @returns {{ text: string, unterminated: boolean }}
 */
export function stripComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let unterminated = false;

  /** Last significant (non-whitespace, non-comment) character emitted. */
  let lastSignificant = "\n";
  /** Last identifier-ish word, for the keyword heuristic. */
  let lastWord = "";

  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      // Keep newlines so line numbers survive.
      if (src[k] !== "\n" && src[k] !== "\r") out[k] = " ";
    }
  };

  const noteSignificant = (ch) => {
    lastSignificant = ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord += ch;
    } else {
      lastWord = "";
    }
  };

  while (i < n) {
    const ch = src[i];

    // ── line comment ──────────────────────────────────────────────────────
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ── block comment ─────────────────────────────────────────────────────
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) {
        blank(i, n);
        unterminated = true;
        break;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    // ── strings and templates ─────────────────────────────────────────────
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (src[k] === "\\") {
          k += 2;
          continue;
        }
        if (src[k] === quote) break;
        k += 1;
      }
      if (k >= n) {
        unterminated = true;
        i = n;
        break;
      }
      // `${...}` inside a template can hold real code, comments included. It is
      // rare in an import-bearing file, and treating it as opaque text only
      // risks missing an import written inside an interpolation — never a
      // false positive. Cheap and safe; documented rather than faked.
      for (let j = i; j <= k; j++) noteSignificant(src[j]);
      i = k + 1;
      continue;
    }

    // ── regex literal vs division ─────────────────────────────────────────
    if (ch === "/") {
      const canBeRegex =
        REGEX_KEYWORDS.has(lastWord) || DIVISION_PRECEDERS.has(lastSignificant);
      if (canBeRegex) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < n) {
          const c = src[k];
          if (c === "\\") {
            k += 2;
            continue;
          }
          if (c === "\n") break; // unterminated on one line: not a regex
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) {
            closed = true;
            break;
          }
          k += 1;
        }
        if (closed) {
          for (let j = i; j <= k; j++) noteSignificant(src[j]);
          i = k + 1;
          continue;
        }
      }
    }

    if (!/\s/.test(ch)) noteSignificant(ch);
    i += 1;
  }

  return { text: out.join(""), unterminated };
}

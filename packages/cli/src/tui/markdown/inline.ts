/**
 * Inline Markdown tokenizer and its tag emitter.
 *
 * ## Why a tokenizer replaces the regex
 *
 * `renderInlineMarkdown` used one alternation regex over the whole line. That
 * cannot express nesting (`**bold *em***`), cannot consume backslash escapes
 * (the regex never sees the `\` — `escapeTags` runs after matching), and grows
 * one more unmaintainable group per token kind. The grammar is small enough to
 * scan by hand and the scan is what plan 614 §5.2 specifies.
 *
 * ## The contract with the callers
 *
 * - Input is ONE line. Nothing here introduces a newline: the block line-count
 *   invariant (`transcript-view.ts` header, rule at the top) is a hard
 *   constraint, and the table renderer relies on cell renders staying one row.
 * - Text payloads must go through `escapeTags` exactly once. The style
 *   functions (`stylesOf`) already escape their argument, so this module only
 *   escapes the segments it emits BARE (plain text, link labels, image alt).
 * - `renderInlineTokens` emits only complete `{tag}…{/tag}` pairs around its
 *   children, so pairing is structural — the fuzz test pins it anyway (V5).
 *
 * ## What is deliberately NOT here
 *
 * HTML entities, autolinks `<https://…>`, reference links `[a][b]`, and
 * footnote syntax — the model rarely emits them in a terminal transcript and
 * each would add a token kind that all three render chains must then agree on
 * (plan D9). The grammar stays at the plan's eight productions.
 */

import { escapeTags } from './escape.js';
import type { Styles } from '../transcript-view.js';

/** One inline construct. `text` is a literal run; the rest carry children. */
export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly InlineToken[] }
  | { readonly kind: 'emphasis'; readonly children: readonly InlineToken[] }
  | { readonly kind: 'strike'; readonly children: readonly InlineToken[] }
  | { readonly kind: 'link'; readonly label: string; readonly target: string }
  | { readonly kind: 'image'; readonly alt: string; readonly target: string };

/** ASCII punctuation that a backslash may escape (CommonMark's set). */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;

/** A word character, for `_`'s word-boundary rule. */
const WORD = /[A-Za-z0-9_]/u;

/**
 * Tokenize one line of inline Markdown.
 *
 * The scan is left-to-right with single-token backtracking: when an opener
 * fails to find its closer the opener's first character falls back to plain
 * text and the scan resumes one character later, so `**a*` degrades to `*`
 * + `*a*` rather than swallowing the line. Code spans win by position — they
 * are just the first candidate the scanner reaches — and their content is
 * never re-scanned, so `` `**not bold**` `` stays literal.
 */
export function tokenizeInline(text: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let plain = '';
  let index = 0;

  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ kind: 'text', text: plain });
      plain = '';
    }
  };

  while (index < text.length) {
    const char = text[index] ?? '';

    // Backslash escape: any ASCII punctuation becomes literal. A backslash
    // before anything else stays itself — CommonMark's rule.
    if (char === '\\' && PUNCTUATION.test(text[index + 1] ?? '')) {
      plain += text[index + 1] ?? '';
      index += 2;
      continue;
    }

    if (char === '`') {
      const fence = runOf(text, index, '`');
      const close = findCodeClose(text, index + fence, fence);
      if (close !== -1) {
        flush();
        tokens.push({ kind: 'code', text: text.slice(index + fence, close) });
        index = close + fence;
        continue;
      }
      plain += '`';
      index += 1;
      continue;
    }

    if (text.startsWith('**', index) || text.startsWith('__', index)) {
      const marker = text.slice(index, index + 2);
      const close = text.indexOf(marker, index + 2);
      if (close !== -1) {
        flush();
        tokens.push({
          kind: 'strong',
          children: tokenizeInline(text.slice(index + 2, close)),
        });
        index = close + 2;
        continue;
      }
      plain += marker[0] ?? '*';
      index += 1;
      continue;
    }

    if (text.startsWith('~~', index)) {
      const close = text.indexOf('~~', index + 2);
      if (close !== -1) {
        flush();
        tokens.push({
          kind: 'strike',
          children: tokenizeInline(text.slice(index + 2, close)),
        });
        index = close + 2;
        continue;
      }
      plain += '~';
      index += 1;
      continue;
    }

    if (char === '*') {
      const close = text.indexOf('*', index + 1);
      const content = close === -1 ? '' : text.slice(index + 1, close);
      if (close !== -1 && content !== '' && !content.startsWith(' ') && !content.endsWith(' ')) {
        flush();
        tokens.push({ kind: 'emphasis', children: tokenizeInline(content) });
        index = close + 1;
        continue;
      }
      plain += '*';
      index += 1;
      continue;
    }

    if (char === '_') {
      const atStart = index === 0 || !WORD.test(text[index - 1] ?? '');
      const close = text.indexOf('_', index + 1);
      const content = close === -1 ? '' : text.slice(index + 1, close);
      const afterEnd = text[close + 1] ?? '';
      const atEnd = close === -1 || !WORD.test(afterEnd);
      if (atStart && atEnd && content !== '' && !content.startsWith(' ') && !content.endsWith(' ')) {
        flush();
        tokens.push({ kind: 'emphasis', children: tokenizeInline(content) });
        index = close + 1;
        continue;
      }
      plain += '_';
      index += 1;
      continue;
    }

    if (char === '[' || text.startsWith('![', index)) {
      const image = char === '!';
      const labelStart = index + (image ? 2 : 1);
      const bracket = text.indexOf(']', labelStart);
      const parsed = bracket === -1 ? undefined : parseLinkTarget(text, bracket + 1);
      if (parsed !== undefined) {
        flush();
        if (image) {
          tokens.push({ kind: 'image', alt: text.slice(labelStart, bracket), target: parsed.target });
        } else {
          tokens.push({ kind: 'link', label: text.slice(labelStart, bracket), target: parsed.target });
        }
        index = parsed.end;
        continue;
      }
      // Not a link/image: the `!` or `[` is text. Fall through by one char so
      // `![alt](bad url)` still renders `!` and re-tries `[alt](…)`.
      plain += image ? '!' : '[';
      index += 1;
      continue;
    }

    plain += char;
    index += 1;
  }

  flush();
  return tokens;
}

/** Count the run of one character starting at `index`. */
function runOf(text: string, index: number, char: string): number {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

/**
 * Find the close of a code span: a backtick run of the SAME length. A longer
 * run inside the span belongs to the content (`` `` a```b `` keeps scanning) —
 * same-length fences are CommonMark's rule and what the old regex expressed.
 */
function findCodeClose(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === '`') {
      const run = runOf(text, index, '`');
      if (run === length) return index;
      index += run;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** Parse `(target)` immediately at `at`; returns the target and end position. */
function parseLinkTarget(
  text: string,
  at: number,
): { target: string; end: number } | undefined {
  if (text[at] !== '(') return undefined;
  const close = text.indexOf(')', at + 1);
  if (close === -1) return undefined;
  const target = text.slice(at + 1, close);
  // A target with spaces is a title-style link this renderer does not speak;
  // leave it as text rather than rendering half a URL.
  if (target === '' || /\s/u.test(target)) return undefined;
  return { target, end: close + 1 };
}

/**
 * The raw open/close tag pair behind one style function.
 *
 * The style functions (`styles.bold`, …) escape their payload — that is the
 * right contract for hand-written call sites, but the tokenizer renders its
 * children FIRST (already escaped) and then wraps them, so it needs the bare
 * tags to avoid double-escaping `{open}` into `{open}open}`. Probing with a
 * sentinel extracts the pair without widening the `Styles` interface; Phase 5
 * (thinking bold-on-muted) needs exactly the same primitive.
 */
const PROBE_SENTINEL = '\u0000';

/** Extract the bare `{tag}` / `{/tag}` pair behind one style function. */
export function rawTagPair(emit: (s: string) => string): { open: string; close: string } {
  const wrapped = emit(PROBE_SENTINEL);
  const at = wrapped.indexOf(PROBE_SENTINEL);
  return { open: wrapped.slice(0, at), close: wrapped.slice(at + PROBE_SENTINEL.length) };
}

function probePair(emit: (s: string) => string): { open: string; close: string } {
  return rawTagPair(emit);
}

/**
 * Compress tokens back into a blessed tag string, guaranteeing every open tag
 * has its close (V5). The tag BODIES still come from the styles object — this
 * function decides which children each pair wraps and escapes the leaf text
 * exactly once.
 */
export function renderInlineTokens(
  tokens: readonly InlineToken[],
  styles: Pick<Styles, 'muted' | 'bold' | 'accent' | 'link'>,
): string {
  const muted = probePair(styles.muted);
  const bold = probePair(styles.bold);
  const accent = probePair(styles.accent);
  const link = probePair(styles.link);

  const render = (list: readonly InlineToken[]): string => {
    let out = '';
    for (const token of list) {
      switch (token.kind) {
        case 'text':
          out += escapeTags(token.text);
          break;
        case 'code':
          out += `${muted.open}${escapeTags(token.text)}${muted.close}`;
          break;
        case 'strong':
          out += `${bold.open}${render(token.children)}${bold.close}`;
          break;
        case 'emphasis':
          out += `${accent.open}${render(token.children)}${accent.close}`;
          break;
        case 'strike':
          // Strike is an SGR 9 attribute the blessed chain cannot express yet
          // (plan 614 §5.3 defers the token to Phase 6); muted keeps it
          // visible rather than invisible.
          out += `${muted.open}${render(token.children)}${muted.close}`;
          break;
        case 'link': {
          // D7's conservative shape, already the shipped behaviour: the label
          // stays readable, the target rides along in the link style.
          out += `${escapeTags(token.label)} ${link.open}(${escapeTags(token.target)})${link.close}`;
          break;
        }
        case 'image': {
          // D8: give the alt text and say it is an image — never pretend one
          // was shown. The old regex path rendered this as `!alt (url)`.
          out += `${escapeTags(token.alt)} ${muted.open}[image]${muted.close} ${link.open}(${escapeTags(token.target)})${link.close}`;
          break;
        }
      }
    }
    return out;
  };

  return render(tokens);
}

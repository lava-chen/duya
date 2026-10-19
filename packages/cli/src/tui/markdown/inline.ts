/**
 * Inline Markdown: the tokenizer, and the tag view over its spans.
 *
 * ## Why a tokenizer replaces the regex
 *
 * `renderInlineMarkdown` used one alternation regex over the whole line. That
 * cannot express nesting (`**bold *em***`), cannot consume backslash escapes
 * (the regex never sees the `\` — `escapeTags` runs after matching), and grows
 * one more unmaintainable group per token kind. The grammar is small enough to
 * scan by hand and the scan is what plan 614 §5.2 specifies.
 *
 * ## Where the styles are decided now (plan 615 Phase 1)
 *
 * The token tree is lowered to `StyledSpan[]` by `core/span.ts`, and both
 * writers consume that: `spansToTags` here (the blessed-tag compatibility
 * view) and `spansToAnsi` in `terminal/ansi.ts`. Nothing in this file decides
 * what a construct MEANS any more — only how to spell it as a tag. That split
 * is what makes it possible to ask "do the two spellings paint the same
 * screen?" and get an honest answer (see `__tests__/span.test.ts`).
 *
 * ## The contract with the callers
 *
 * - Input is ONE line. Nothing here introduces a newline: the block line-count
 *   invariant (`transcript-view.ts` header, rule at the top) is a hard
 *   constraint, and the table renderer relies on cell renders staying one row.
 * - Text payloads are escaped to blessed's vocabulary (`{open}`) exactly once,
 *   in `spansToTags`. Spans carry RAW text, which is what lets the ANSI writer
 *   emit it unchanged.
 * - `renderInlineTokens` emits only complete `{tag}…{/tag}` pairs, so pairing
 *   is structural — the fuzz test pins it anyway (V5).
 *
 * ## What is deliberately NOT here
 *
 * HTML entities, autolinks `<https://…>`, reference links `[a][b]`, and
 * footnote syntax — the model rarely emits them in a terminal transcript and
 * each would add a token kind that all three render chains must then agree on
 * (plan D9). The grammar stays at the plan's eight productions.
 */

import { escapeTags } from './escape.js';
import { colorFromTagBody, sameColor, tagBodyFor, type SpanColor } from '../core/color.js';
import {
  attrs,
  mergeSpanStyles,
  tokensToSpans,
  PLAIN_STYLE,
  type InlineSpanRoles,
  type SpanStyle,
  type StyledSpan,
} from '../core/span.js';
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

export { probePair as rawTagPair };

/**
 * Everything the tag view needs from the theme: which renderer will parse the
 * tags, and the two colours an attribute may be degraded to.
 */
export interface SpanTagView {
  readonly renderer: 'blessed' | 'own';
  /** Where `italic` goes when the renderer cannot paint it. */
  readonly accent: SpanColor;
  /** Where `strike` goes when the renderer cannot paint it. */
  readonly muted: SpanColor;
}

/** Resolve the tag view from the style set a caller already has. */
export function tagViewOf(styles: Pick<Styles, 'renderer' | 'tags'>): SpanTagView {
  return {
    renderer: styles.renderer,
    accent: colorFromTagBody(styles.tags.accent) ?? { kind: 'named', name: 'cyan' },
    muted: colorFromTagBody(styles.tags.muted) ?? { kind: 'named', name: 'gray' },
  };
}

/** Resolve the span roles (the colours inline Markdown needs) from the theme. */
export function spanRolesOf(styles: Pick<Styles, 'tags'>): InlineSpanRoles {
  return {
    muted: colorFromTagBody(styles.tags.muted) ?? { kind: 'named', name: 'gray' },
    accent: colorFromTagBody(styles.tags.accent) ?? { kind: 'named', name: 'cyan' },
    link: colorFromTagBody(styles.tags.link) ?? { kind: 'named', name: 'gray' },
  };
}

/**
 * The tags that open one style, in the order they should nest.
 *
 * `order` is not arbitrary. The envelope (a heading's colour around a whole
 * line) opens colour-first, because that is the shape the pre-615 renderer
 * emitted and the markup tests pin it. A per-span delta opens attributes
 * first, which is the rule `own/markup.ts` measured against blessed: it emits
 * `{bold}{241-fg}` as `1;38;5;241`, and the same internal order keeps the tag
 * strings readable next to the bytes they produce.
 */
function openTags(style: SpanStyle, order: 'color-first' | 'attrs-first', view: SpanTagView): string[] {
  const colour = style.fg === undefined ? [] : [`{${tagBodyFor(style.fg)}}`];
  const attributes = (style.attrs ?? []).map((attribute) => `{${attribute}}`);
  return order === 'color-first' ? [...colour, ...attributes] : [...attributes, ...colour];
}

/**
 * Apply the renderer's limitations to a span's style.
 *
 * Blessed has no italic and no strike (its `_attr` prints the tags literally),
 * so those attributes have to become colours there. This is deliberately in the
 * TAG view and not in `tokensToSpans`: the span says what the text MEANS, and
 * each output decides how to approximate it. Putting the fold earlier would
 * make the shared representation a blessed-shaped one.
 */
function resolveForRenderer(style: SpanStyle, view: SpanTagView): SpanStyle {
  if (view.renderer === 'own') return style;
  const listed = style.attrs ?? [];
  let fg = style.fg;
  let changed = false;
  if (listed.includes('strike')) {
    fg = view.muted;
    changed = true;
  }
  if (listed.includes('italic')) {
    // Italic is applied last: when a span somehow carries both, emphasis is the
    // stronger signal and the more recent one in the source order.
    fg = view.accent;
    changed = true;
  }
  if (!changed) return style;
  const kept = attrs(...listed.filter((attribute) => attribute !== 'italic' && attribute !== 'strike'));
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(kept.length === 0 ? {} : { attrs: kept }),
    ...(style.bg === undefined ? {} : { bg: style.bg }),
    ...(style.linkId === undefined ? {} : { linkId: style.linkId }),
  };
}

/** Tags for the parts of `style` the envelope does not already establish. */
function deltaTags(style: SpanStyle, envelope: SpanStyle, view: SpanTagView): string[] {
  const out: string[] = [];
  const inherited = new Set(envelope.attrs ?? []);
  for (const attribute of style.attrs ?? []) {
    if (!inherited.has(attribute)) out.push(`{${attribute}}`);
  }
  if (style.fg !== undefined && !sameColor(style.fg, envelope.fg)) out.push(`{${tagBodyFor(style.fg)}}`);
  if (style.bg !== undefined && !sameColor(style.bg, envelope.bg)) out.push(`{${tagBodyFor(style.bg)}}`);
  return out;
}

/** Longest common prefix length of two tag lists. */
function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Serialise spans to blessed-style tags — the compatibility view.
 *
 * Two properties matter and both are tested:
 *
 * - **Minimal transitions.** Only the tags that CHANGED are emitted, so a
 *   coloured run inside a bold run reads `{bold}a {gray-fg}b{/gray-fg} c{/bold}`
 *   rather than closing and reopening `{bold}` around every span. That is what
 *   keeps the string the size of the style changes instead of the size of the
 *   text, and it is why the envelope is emitted once rather than merged into
 *   each span.
 * - **Balanced, LIFO closes.** Every open tag is closed in reverse order, which
 *   the fuzz test in `inline-tokens.test.ts` pins for 2,000 random inputs.
 *
 * The envelope is the outer frame: a heading's colour, and later any
 * block-level style. Spans are then emitted as deltas against it, which is what
 * lets `# **x**` print `{cyan-fg}{bold}x{/bold}{/cyan-fg}` — the colour
 * surviving around the bold rather than being replaced by it.
 */
export function spansToTags(
  spans: readonly StyledSpan[],
  view: SpanTagView,
  envelope: SpanStyle = PLAIN_STYLE,
): string {
  const outer = resolveForRenderer(envelope, view);
  const outerTags = openTags(outer, 'color-first', view);
  let out = outerTags.join('');
  let open = outerTags;

  for (const span of spans) {
    const style = resolveForRenderer(mergeSpanStyles(outer, span), view);
    const target = [...outerTags, ...deltaTags(style, outer, view)];
    const shared = commonPrefix(open, target);
    for (let index = open.length - 1; index >= shared; index -= 1) {
      out += `{/${closeBody(open[index] ?? '')}}`;
    }
    out += target.slice(shared).join('');
    out += escapeTags(span.text);
    open = target;
  }

  for (let index = open.length - 1; index >= 0; index -= 1) {
    out += `{/${closeBody(open[index] ?? '')}}`;
  }
  return out;
}

/** `{bold}` → `bold`, so the matching close can be built. */
function closeBody(openTag: string): string {
  return openTag.slice(1, -1);
}

/**
 * Compress tokens back into a blessed tag string, guaranteeing every open tag
 * has its close (V5).
 *
 * Since Phase 1 this is a VIEW over `tokensToSpans`, not a separate renderer:
 * the token→style decisions live in `core/span.ts` and are shared with the
 * ANSI writer, so the two cannot drift. The tag spelling still comes from the
 * theme, which is what keeps every existing markup test byte-identical.
 */
export function renderInlineTokens(
  tokens: readonly InlineToken[],
  styles: Pick<Styles, 'renderer' | 'tags'>,
  envelope: SpanStyle = PLAIN_STYLE,
): string {
  return spansToTags(tokensToSpans(tokens, spanRolesOf(styles)), tagViewOf(styles), envelope);
}

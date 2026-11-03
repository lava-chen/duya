/**
 * Tags → spans: the inverse of the compatibility view.
 *
 * ## Why the tree needs this
 *
 * Every legacy renderer in the TUI emits a tagged STRING (`buildFooterLines`,
 * `QuestionAskState.render`, the whole of `transcript-view.ts`). To put one on
 * a scene, the string has to become spans — and it has to become the SAME spans
 * `spansToTags` would have produced, or the tree would paint a line differently
 * from the string it came from.
 *
 * So the two are tested as a round trip: for a corpus of tagged strings,
 * `spansToTags(tagsToSpans(line)) === line`, and for a corpus of spans,
 * `tagsToSpans(spansToTags(spans))` yields spans that paint identically. That
 * is what makes it safe to migrate a renderer onto the tree one at a time
 * (plan 615 Phase 6) while the other paths keep working.
 *
 * ## The rules are `renderMarkup`'s, restated over spans
 *
 * - `{open}` / `{close}` are literal braces, resolved BEFORE tag lookup, because
 *   that is the order every other parser in the repository uses.
 * - An unknown tag is literal text, never dropped: a mistyped or model-authored
 *   tag must stay visible.
 * - Attributes accumulate up the stack; a colour is REPLACED by the innermost
 *   one that sets it. Stacking is what makes `{bold}a{gray-fg}b{/gray-fg}c` come
 *   out as bold throughout with `b` muted.
 *
 * ## Foreground and background are separate slots
 *
 * A `{236-bg}` tag fills the cell behind the text and leaves the text colour
 * alone; a `{236-fg}` tag does the opposite. They are two slots on the same
 * stack, each replaced by the innermost tag that sets it, which is why a band
 * can carry coloured text inside it without the two fighting.
 */

import { colorFromTagBody, type ColorSlot } from './color.js';
import { attrs, sameStyle, type SpanAttribute, type SpanStyle, type StyledSpan } from './span.js';

const TAG = /\{(\/?)([a-zA-Z0-9#_-]+)\}/gu;

/** Attribute tags, the vocabulary `spansToTags` emits. */
const ATTRIBUTE_TAGS: Readonly<Record<string, SpanAttribute>> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  underline: 'underline',
};

/** One frame of the style stack: what a single open tag added. */
interface StyleFrame {
  readonly attr?: SpanAttribute;
  readonly fg?: SpanStyle['fg'];
  readonly bg?: SpanStyle['bg'];
}

/** Which slot a tag body fills. `-bg` is a background; everything else a foreground. */
function slotOf(body: string): ColorSlot {
  return body.endsWith('-bg') ? 'bg' : 'fg';
}

/** Fold a stack into the style actually in effect. */
function effective(stack: readonly StyleFrame[]): SpanStyle {
  const listed: SpanAttribute[] = [];
  let fg: SpanStyle['fg'];
  let bg: SpanStyle['bg'];
  for (const frame of stack) {
    if (frame.attr !== undefined) listed.push(frame.attr);
    if (frame.fg !== undefined) fg = frame.fg;
    if (frame.bg !== undefined) bg = frame.bg;
  }
  const normalised = attrs(...listed);
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(normalised.length === 0 ? {} : { attrs: normalised }),
  };
}

/** Parse one tagged line into styled spans. */
export function tagsToSpans(line: string): readonly StyledSpan[] {
  if (!line.includes('{')) return line === '' ? [] : [{ text: line }];

  const out: StyledSpan[] = [];
  const stack: StyleFrame[] = [];
  let plain = '';
  let style = effective(stack);

  const flush = (): void => {
    if (plain === '') return;
    out.push({ text: plain, ...style });
    plain = '';
  };

  let cursor = 0;
  TAG.lastIndex = 0;
  let match = TAG.exec(line);
  while (match !== null) {
    plain += line.slice(cursor, match.index);
    const slash = match[1] === '/';
    const body = match[2] ?? '';

    // Literal braces, resolved before anything else. The slash is ignored here
    // on purpose: `{/open}` is a literal `{` in every parser in this repo
    // (`renderMarkup`, `terminal/sgr.ts`), because blessed resolves these two
    // bodies before it looks at the close marker.
    if (body === 'open' || body === 'close') {
      plain += body === 'open' ? '{' : '}';
      cursor = match.index + match[0].length;
      match = TAG.exec(line);
      continue;
    }

    const attribute = ATTRIBUTE_TAGS[body];
    const slot = slotOf(body);
    const color = attribute === undefined && !slash ? colorFromTagBody(body, slot) : undefined;

    if (slash) {
      // A close pops the innermost frame its name opened. Popping blindly would
      // let a stray `{/bold}` steal someone else's style, and an unmatched close
      // must cost nothing rather than unwind the line.
      if (attribute !== undefined) {
        const at = lastIndexOfAttr(stack, attribute);
        if (at !== -1) stack.splice(at, 1);
      } else if (body.endsWith('-fg') || body.endsWith('-bg')) {
        const at = slot === 'bg' ? lastIndexOfBg(stack) : lastIndexOfFg(stack);
        if (at !== -1) stack.splice(at, 1);
      } else {
        plain += match[0];
      }
    } else if (attribute !== undefined) {
      stack.push({ attr: attribute });
    } else if (color !== undefined) {
      stack.push(slot === 'bg' ? { bg: color } : { fg: color });
    } else {
      // Unknown tag: visible text, like every other parser here.
      plain += match[0];
    }

    flush();
    style = effective(stack);
    cursor = match.index + match[0].length;
    match = TAG.exec(line);
  }

  plain += line.slice(cursor);
  flush();
  return coalesce(out);
}

function lastIndexOfAttr(stack: readonly StyleFrame[], attribute: SpanAttribute): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.attr === attribute) return index;
  }
  return -1;
}

function lastIndexOfFg(stack: readonly StyleFrame[]): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.fg !== undefined) return index;
  }
  return -1;
}

function lastIndexOfBg(stack: readonly StyleFrame[]): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.bg !== undefined) return index;
  }
  return -1;
}

/** Merge adjacent spans that paint identically, so a scene row stays compact. */
export function coalesce(spans: readonly StyledSpan[]): readonly StyledSpan[] {
  const out: StyledSpan[] = [];
  for (const span of spans) {
    if (span.text === '') continue;
    const previous = out[out.length - 1];
    if (previous !== undefined && sameStyle(previous, span)) {
      out[out.length - 1] = { ...previous, text: previous.text + span.text };
      continue;
    }
    out.push(span);
  }
  return out;
}

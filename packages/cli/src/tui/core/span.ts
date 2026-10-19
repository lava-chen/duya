/**
 * StyledSpan: the one representation every renderer can eat.
 *
 * ## The problem this solves
 *
 * Today a transcript line is a STRING with blessed tags in it
 * (`{bold}…{cyan-fg}…{/cyan-fg}…{/bold}`). That representation is lossy in the
 * direction that matters: to paint a cell you have to parse the tags back into
 * a style, and to know what a span's width is you have to parse them again.
 * Two renderers therefore each own a tag parser (`screen/own/markup.ts` and
 * `terminal/sgr.ts`), and plan 615 §V8 asks for ONE pipeline feeding both.
 *
 * A `StyledSpan` is text plus the style that applies to it, resolved once,
 * before either renderer sees it:
 *
 *     tokens ──tokensToSpans──▶ StyledSpan[] ──┬─▶ spansToTags ─▶ blessed
 *                    (structure)              └─▶ spansToAnsi ─▶ inline / own
 *
 * The tag layer survives only as a compatibility view until Phase 5, but it is
 * now DOWNSTREAM of the span, not the way spans are stored.
 *
 * ## Why the style is flat, and why that is not lossy
 *
 * Markdown nests constructs (`**a *b* c**`), so a naive design would keep the
 * tree. It does not have to: SGR attributes and the single foreground colour
 * compose, so what the terminal actually shows is a FLAT set of attributes plus
 * the innermost colour. `tokensToSpans` applies that composition, which is the
 * same rule `own/markup.ts` measured against blessed ("a colour REPLACES, it
 * does not stack").
 *
 * The one thing flattening does lose is the ORDER the constructs were nested
 * in. That order is invisible on screen (SGR 1;3 and 3;1 paint identically) and
 * it is reconstructed, deterministically, at serialisation time. See
 * `spansToTags`, which prefers the ordering that keeps the most tags already
 * open — the difference-minimising choice, not an arbitrary one.
 *
 * ## Why attributes are an ordered array and not a Set
 *
 * Serialisation must be deterministic: the same span has to produce the same
 * bytes on every run, or the caches and the parity tests stop meaning anything.
 * Set iteration order is insertion order, which depends on the order a span was
 * composed — precisely the fact flattening just discarded. A canonical-order
 * array makes `[…attrs]` itself the byte order and makes equality a simple
 * comparison.
 */

import type { InlineToken } from '../markdown/inline.js';
import { sameColor, type SpanColor } from './color.js';

/** The attributes this vocabulary can express. */
export type SpanAttribute = 'bold' | 'italic' | 'strike' | 'underline';

/**
 * Serialisation order for attributes.
 *
 * Not cosmetic: `own/markup.ts` measured that blessed emits attributes BEFORE
 * the colour (`{bold}{241-fg}` → `1;38;5;241`), and the parity tests pin those
 * bytes. Fixing the order here means every serializer downstream inherits it
 * instead of re-deciding.
 */
const ATTRIBUTE_ORDER: readonly SpanAttribute[] = ['bold', 'italic', 'strike', 'underline'];

/** The style fields of a span, without its text. */
export interface SpanStyle {
  readonly fg?: SpanColor;
  readonly bg?: SpanColor;
  /** Canonical order, deduped. Never mutate; build it with `attrs()`. */
  readonly attrs?: readonly SpanAttribute[];
  /**
   * Reserved for OSC 8 hyperlinks (plan 615 §O3): a stable id an output may
   * later use to emit `ESC ] 8 ; …`. Nothing emits OSC 8 yet, and the ANSI
   * serializer treats it as a no-op, so setting it cannot change any bytes
   * before that lands.
   */
  readonly linkId?: string;
}

/** A run of text with one effective style. */
export interface StyledSpan extends SpanStyle {
  readonly text: string;
}

/**
 * One frame's worth of styled text.
 *
 * `cursor` is where the terminal caret goes; `caret` is the transcript's
 * selection anchor. They are separate because an inline TUI can have one
 * without the other (a selection while the editor is not focused).
 */
export interface RenderScene {
  readonly rows: readonly (readonly StyledSpan[])[];
  readonly cursor?: { readonly row: number; readonly column: number };
  readonly caret?: { readonly row: number; readonly column: number };
}

/** Normalise an attribute list: dedupe and put it in serialisation order. */
export function attrs(...list: readonly (SpanAttribute | undefined | false)[]): readonly SpanAttribute[] {
  const wanted = new Set<SpanAttribute>();
  for (const item of list) if (item) wanted.add(item);
  return ATTRIBUTE_ORDER.filter((attribute) => wanted.has(attribute));
}

/** The attributes on a style, as a set-free lookup. */
export function hasAttr(style: SpanStyle, attribute: SpanAttribute): boolean {
  return style.attrs?.includes(attribute) === true;
}

/** No style at all. Shared so the common plain span does not allocate one. */
export const PLAIN_STYLE: SpanStyle = {};

/** A span of unstyled text. */
export function plainSpan(text: string): StyledSpan {
  return { text };
}

/** A span of text with a style. */
export function styledSpan(text: string, style: SpanStyle): StyledSpan {
  return { text, ...style };
}

/**
 * Compose two styles: `inner` is applied on top of `outer`.
 *
 * Attributes union; a colour is REPLACED by the inner one when the inner style
 * sets it (the measured blessed rule — `{cyan-fg}{yellow-fg}` emits `33`
 * alone). That is what makes nesting behave like nesting without a tree.
 */
export function mergeSpanStyles(outer: SpanStyle, inner: SpanStyle): SpanStyle {
  const merged = attrs(...(outer.attrs ?? []), ...(inner.attrs ?? []));
  const fg = inner.fg ?? outer.fg;
  const bg = inner.bg ?? outer.bg;
  const linkId = inner.linkId ?? outer.linkId;
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(merged.length === 0 ? {} : { attrs: merged }),
    ...(linkId === undefined ? {} : { linkId }),
  };
}

/** Apply a style on top of every span, keeping their text. */
export function withSpanStyle(
  spans: readonly StyledSpan[],
  style: SpanStyle,
): readonly StyledSpan[] {
  if (Object.keys(style).length === 0) return spans;
  return spans.map((span) => ({ text: span.text, ...mergeSpanStyles(span, style) }));
}

/** The characters the spans describe, styles dropped. */
export function spanText(spans: readonly StyledSpan[]): string {
  let out = '';
  for (const span of spans) out += span.text;
  return out;
}

/** Whether two spans would paint identically. */
export function sameStyle(a: SpanStyle, b: SpanStyle): boolean {
  const attrsA = a.attrs ?? [];
  const attrsB = b.attrs ?? [];
  if (attrsA.length !== attrsB.length) return false;
  for (let i = 0; i < attrsA.length; i += 1) if (attrsA[i] !== attrsB[i]) return false;
  return sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg) && a.linkId === b.linkId;
}

/**
 * The semantic colours inline Markdown needs, resolved from the theme.
 *
 * Passed separately from `tokensToSpans` so the token→span step stays free of
 * theme knowledge: the same tokens must produce the same spans no matter which
 * renderer will paint them (V8). Renderer differences belong to the
 * serialiser, which is where a blessed-only fold like "no italic, use accent"
 * can be applied without contaminating the shared representation.
 */
export interface InlineSpanRoles {
  /** Inline code, quotes, image badge. */
  readonly muted: SpanColor;
  /** The fallback for emphasis on renderers with no italic. */
  readonly accent: SpanColor;
  /** Link targets. */
  readonly link: SpanColor;
}

/**
 * Lower the inline token tree into styled spans.
 *
 * The mapping is the one `renderInlineTokens` performed inline, minus the tag
 * spelling:
 *
 * - `text` → plain
 * - `code` → muted (code is one colour, not a box — the block renderer draws
 *   fences for fenced blocks and this is the inline case)
 * - `strong` → `bold`, inherited by children
 * - `emphasis` → `italic`, inherited by children
 * - `strike` → `strike`, inherited by children
 * - `link` → `label (target)`, the target in the link colour
 * - `image` → `alt [image] (target)`, the badge muted and the target linked
 *
 * Emphasis and strike are emitted as ATTRIBUTES even for the blessed chain:
 * that chain cannot paint them, and degrading is the serialiser's job. Doing it
 * here would bake one renderer's limitation into the shared representation and
 * break the moment a third renderer (Phase 5's) consumes it.
 */
export function tokensToSpans(
  tokens: readonly InlineToken[],
  roles: InlineSpanRoles,
  inherited: SpanStyle = PLAIN_STYLE,
): readonly StyledSpan[] {
  const out: StyledSpan[] = [];

  const push = (text: string, style: SpanStyle): void => {
    if (text === '') return;
    out.push({ text, ...style });
  };

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        push(token.text, inherited);
        break;
      case 'code':
        push(token.text, mergeSpanStyles(inherited, { fg: roles.muted }));
        break;
      case 'strong':
        out.push(...tokensToSpans(token.children, roles, mergeSpanStyles(inherited, { attrs: ['bold'] })));
        break;
      case 'emphasis':
        out.push(...tokensToSpans(token.children, roles, mergeSpanStyles(inherited, { attrs: ['italic'] })));
        break;
      case 'strike':
        out.push(...tokensToSpans(token.children, roles, mergeSpanStyles(inherited, { attrs: ['strike'] })));
        break;
      case 'link':
        // The label stays readable and the target rides along in the link
        // style — the shape already shipped (plan D7). The space is part of the
        // plain run so the target keeps its own style boundary.
        push(`${token.label} `, inherited);
        push(`(${token.target})`, mergeSpanStyles(inherited, { fg: roles.link }));
        break;
      case 'image':
        // Never pretend an image was shown (D8): say what it is, then where it
        // pointed.
        push(`${token.alt} `, inherited);
        push('[image]', mergeSpanStyles(inherited, { fg: roles.muted }));
        push(' ', inherited);
        push(`(${token.target})`, mergeSpanStyles(inherited, { fg: roles.link }));
        break;
    }
  }

  return out;
}

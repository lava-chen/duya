/**
 * reply.ts — reply-quote composition/parsing for bot-direct chat.
 *
 * Rakazo sends `replyToMessageId` to the server, which injects the quote
 * at the request boundary. Duya's bot-direct pipeline (plan 491 P1.1)
 * carries only a plain `content` string end to end, so the quote rides
 * INSIDE the content behind a deterministic sentinel block, and
 * `displayContent` keeps the plain user text (the bubble renders
 * displayContent — the sentinel never shows as bubble body text).
 *
 * The format is round-trippable: `splitReplyContent(composeReplyContent(t, r))`
 * yields the original quote and text. Persistence needs no schema change —
 * the persisted user row stores the composed content, so the in-bubble
 * reply preview survives reloads (parsed back out at render time).
 *
 * Pure string functions, no React — unit-tested in reply.test.ts.
 */

export interface ReplyQuote {
  /** Message id being replied to (jump target for the preview click). */
  id: string;
  /** Preview text (sender-agnostic; truncated at compose time). */
  text: string;
}

export interface SplitReply {
  reply: ReplyQuote | null;
  text: string;
}

/** Sentinel first line: `[Replying to <id>]` — ids never contain spaces. */
const MARKER_RE = /^\[Replying to (\S+)\]\n/;

/** Quoted lines prefix. */
const LINE_PREFIX = '> ';

/** Compose-time cap for the quoted preview text (chars). */
const QUOTE_MAX_CHARS = 400;

function quoteLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const capped =
    collapsed.length > QUOTE_MAX_CHARS
      ? `${collapsed.slice(0, QUOTE_MAX_CHARS)}…`
      : collapsed;
  return capped ? `${LINE_PREFIX}${capped}` : LINE_PREFIX;
}

/**
 * Prepend the reply sentinel block to the outgoing content. Without a
 * quote this is the identity (plain text flows unchanged).
 */
export function composeReplyContent(text: string, reply?: ReplyQuote): string {
  if (!reply || !reply.id) return text;
  return `[Replying to ${reply.id}]\n${quoteLine(reply.text)}\n\n${text}`;
}

/**
 * Parse the sentinel block back out of a content string. Returns the
 * quote (or null when the content is not a composed reply) and the
 * plain text body. Tolerates composed content whose quote text was
 * empty (bare `>` line).
 */
export function splitReplyContent(content: string): SplitReply {
  if (typeof content !== 'string') return { reply: null, text: '' };
  const marker = content.match(MARKER_RE);
  if (!marker) return { reply: null, text: content };
  const rest = content.slice(marker[0].length);
  const newline = rest.indexOf('\n');
  const quoteLineText = newline === -1 ? rest : rest.slice(0, newline);
  const body = newline === -1 ? '' : rest.slice(newline + 1).replace(/^\n/, '');
  const text = quoteLineText.startsWith(LINE_PREFIX)
    ? quoteLineText.slice(LINE_PREFIX.length)
    : '';
  return { reply: { id: marker[1], text }, text: body };
}

/** True when the content carries a reply sentinel. */
export function isReplyContent(content: unknown): boolean {
  return typeof content === 'string' && MARKER_RE.test(content);
}

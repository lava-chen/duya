/**
 * Mention-chip text rendering (grok-bot 0.18 UI parity).
 *
 * Grok renders `@Agent` tokens in a message bubble as a styled chip
 * (`sand-mention`). Duya messages are plain text, so instead of a rich-text
 * node we split the text on word-bounded `@handle` matches against the
 * known agent names and let the caller wrap each hit in a chip span.
 *
 * Matching mirrors the agent-side parser (packages/agent/src/agent/dm/
 * mentions.ts): each name yields the full lowercase handle, the no-space
 * variant, and the first word; a match must sit at an ASCII word boundary,
 * so CJK names match freely while ASCII names don't match inside longer
 * words. When two names match at the same offset ("Ops" vs "Ops Bot"), the
 * longest handle wins.
 */

import type { ReactNode } from 'react';

interface MentionHit {
  start: number;
  end: number;
  /** Canonical name to display (original case from the roster). */
  name: string;
}

function collectMentionHits(text: string, names: readonly string[]): MentionHit[] {
  const lower = text.toLowerCase();
  const isWordChar = (char: string | undefined) =>
    char !== undefined && /[a-z0-9]/.test(char);
  const hits: MentionHit[] = [];
  for (const name of names) {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    const handles = new Set<string>([trimmed, trimmed.replace(/\s+/g, '')]);
    const first = trimmed.split(/\s+/)[0];
    if (first) handles.add(first);
    for (const handle of handles) {
      const needle = `@${handle}`;
      for (
        let index = lower.indexOf(needle);
        index >= 0;
        index = lower.indexOf(needle, index + 1)
      ) {
        if (isWordChar(lower[index - 1])) continue;
        if (isWordChar(lower[index + needle.length])) continue;
        hits.push({ start: index, end: index + needle.length, name });
      }
    }
  }
  // Longest handle first, then earliest; ties (two agents sharing a handle,
  // e.g. "Ops" and "Ops Bot" both claiming 'ops') prefer the longer
  // canonical name as the more specific match.
  hits.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      b.name.length - a.name.length,
  );
  const accepted: MentionHit[] = [];
  let lastEnd = -1;
  for (const hit of hits) {
    if (hit.start < lastEnd) continue;
    accepted.push(hit);
    lastEnd = hit.end;
  }
  return accepted;
}

/**
 * Split `text` into plain slices and mention parts. Each mention renders as
 * `@{canonical name}` wrapped in a `bot-mention` chip span; plain slices
 * pass through unchanged (whitespace included — the bubble supplies
 * `white-space: pre-wrap`).
 */
export function renderTextWithMentions(
  text: string,
  names: readonly string[],
): ReactNode {
  if (!text || names.length === 0) return text;
  const hits = collectMentionHits(text, names);
  if (hits.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) parts.push(text.slice(cursor, hit.start));
    parts.push(
      <span key={`${hit.start}-${hit.name}`} className="bot-mention">
        {`@${hit.name}`}
      </span>,
    );
    cursor = hit.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

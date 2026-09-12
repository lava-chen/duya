/**
 * Turn a plain-text message body into renderable segments where plugin
 * @-mentions become chips.
 *
 * Two mention encodings reach a rendered message:
 *
 *   1. `[@Display Name](plugin://pluginId)` — the structured link the submit
 *      path writes for the model (`rewritePluginMentionTokens`).
 *   2. `@pluginId` / `@plugin-slug` — the bare token the composer holds and
 *      `displayContent` stores, so a user bubble normally carries this form.
 *
 * Mention chips are resolved against the installed-plugin list. A bare token
 * that resolves to nothing stays plain text (prose like "email me @home"), and
 * a structured link renders even when the plugin is not installed (its label is
 * authoritative), just without a brand icon.
 */

import { findPluginMentionSpans, type PluginMentionTarget } from './message-input-logic';

export interface PluginMentionTextSegment {
  type: 'text';
  value: string;
}

export interface PluginMentionChipSegment {
  type: 'mention';
  pluginId: string;
  /** Visible chip label: the installed plugin's display name when known. */
  label: string;
  iconUrl?: string;
}

export type PluginMentionSegment = PluginMentionTextSegment | PluginMentionChipSegment;

/** `[@Name](plugin://id)` — the optional `@` tolerates hand-written links. */
const PLUGIN_LINK_RE = /\[@?([^\]]*)\]\(plugin:\/\/([^)\s]+)\)/g;

const PLUGIN_URL_SCHEME = 'plugin://';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extract the plugin id from a `plugin://<id>` URL, or `null` when the URL is
 * not a plugin mention. Used by the markdown anchor renderer, which turns such
 * links into a chip instead of navigating.
 */
export function parsePluginMentionHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw.toLowerCase().startsWith(PLUGIN_URL_SCHEME)) return null;
  const id = safeDecode(
    raw.slice(PLUGIN_URL_SCHEME.length).replace(/^\/+/, '').replace(/\/+$/, '').trim(),
  );
  return id || null;
}

interface MentionMark {
  start: number;
  end: number;
  pluginId: string;
  label: string;
}

/**
 * Split `text` into text + mention-chip segments. Structured links win over
 * bare tokens: a `@Name` sitting inside `[@Name](plugin://id)` is part of the
 * link, not a second mention.
 */
export function splitPluginMentionText(
  text: string,
  targets: readonly PluginMentionTarget[],
): PluginMentionSegment[] {
  if (!text) return [];

  const byId = new Map(targets.map((t) => [t.pluginId.toLowerCase(), t]));

  const marks: MentionMark[] = [];
  for (const match of text.matchAll(PLUGIN_LINK_RE)) {
    const label = (match[1] ?? '').trim().replace(/^@/, '');
    const pluginId = safeDecode((match[2] ?? '').trim());
    if (!pluginId) continue;
    const start = match.index ?? 0;
    marks.push({ start, end: start + match[0].length, pluginId, label });
  }

  for (const span of findPluginMentionSpans(text, targets)) {
    const overlapsLink = marks.some((m) => span.start < m.end && m.start < span.end);
    if (overlapsLink) continue;
    marks.push({ start: span.start, end: span.end, pluginId: span.pluginId, label: '' });
  }

  if (marks.length === 0) return [{ type: 'text', value: text }];
  marks.sort((a, b) => a.start - b.start);

  const segments: PluginMentionSegment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, mark.start) });
    }
    const target = byId.get(mark.pluginId.toLowerCase());
    segments.push({
      type: 'mention',
      pluginId: mark.pluginId,
      label: target?.name || mark.label || `@${mark.pluginId}`,
      iconUrl: target?.iconUrl,
    });
    cursor = mark.end;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}

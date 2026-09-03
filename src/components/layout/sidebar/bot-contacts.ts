/**
 * bot-contacts.ts — pure data helpers for the sidebar's Bots section
 * (plan 483 Phase 1).
 *
 * A "bot contact" is the Telegram-style list entry for one configured
 * agent. Identity comes from the merged read side (`listBots()` IPC:
 * config.toml `[agents.<id>]` declaration layer + `agents/<id>/profile.json`
 * identity layer, plan 485 §2.4). Its chat view is the read view of the
 * agent's persistent session, which plan 477 will bind via the
 * `bot:<agentId>:<sessionId>` id convention. Until that binding exists,
 * contacts render from config alone and clicking falls back to the
 * placeholder thread id `bot:<agentId>` (an empty chat shell).
 *
 * Group contacts (rooms, `room:<roomId>`) are intentionally not built
 * here: their source (`~/.duya/groups.toml`) lands with plan 478 / the
 * settings write side (483 Phase 3). The `room:` id prefix routing is
 * already wired in `section-system.ts`.
 */

import type { Thread } from '@/stores/conversation-store';
import { SESSION_KIND_PREFIXES } from './section-system';

/**
 * One bot from the merged read side (mirrors `BotListItem` in
 * src/lib/agent-profile-ipc.ts).
 */
export interface BotSource {
  id: string;
  name: string;
  title: string;
  description: string;
  model?: string;
  workspace?: string;
  avatarShape?: string;
  avatarColor?: string;
}

export interface BotContact {
  /** Config agent id (`[agents.<id>]`), stable identity of the bot. */
  agentId: string;
  /** Display name (profile.json / config `name`, falling back to the id). */
  name: string;
  /** Role subtitle (profile.json only; not seeded from config). */
  title: string;
  description: string;
  model: string;
  /** Grok-style avatar character tokens (empty → fallback initial circle). */
  avatarShape?: string;
  avatarColor?: string;
  /**
   * Thread id of the bot's bound persistent session
   * (`bot:<agentId>:<sessionId>`, plan 477 convention), or null while
   * no bound session exists in the local thread list.
   */
  boundThreadId: string | null;
  /** Latest activity of the bound session (0 when unbound). */
  lastActivity: number;
  /** Plan 483 P2: pinned to the top of the Bots section (ordered by `sidebar.botPinnedIds`). */
  isPinned?: boolean;
  /** Plan 483 P2: hidden from the sidebar (still configured; restorable). */
  isHidden?: boolean;
}

/**
 * Deterministic hue in [0, 360) for the fallback avatar circle. Same
 * agent id → same color everywhere.
 */
export function deriveBotContactHue(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** Placeholder thread id used to open a bot with no bound session yet. */
export function deriveBotPlaceholderThreadId(agentId: string): string {
  return `${SESSION_KIND_PREFIXES.bot}${agentId}`;
}

/**
 * Resolve the thread id to open for a bot contact: prefer the bound
 * persistent session (477 convention `bot:<agentId>:<sessionId>`), fall
 * back to the placeholder id (empty chat shell) until 477 lands.
 */
export function resolveBotOpenThreadId(
  contact: BotContact,
  threads: Thread[],
): string {
  if (contact.boundThreadId) return contact.boundThreadId;
  const prefix = `${SESSION_KIND_PREFIXES.bot}${contact.agentId}:`;
  const bound = threads.find((t) => t.id.startsWith(prefix));
  return bound?.id ?? deriveBotPlaceholderThreadId(contact.agentId);
}

/**
 * Build the contact list from the merged bot read side + the local
 * thread list. Contacts without a bound session still render (the user
 * can open the placeholder chat); sorting is by display name,
 * case-insensitive.
 */
export function buildBotContacts(
  bots: BotSource[],
  threads: Thread[],
): BotContact[] {
  const contacts: BotContact[] = [];
  for (const bot of bots) {
    if (!bot?.id) continue;
    const prefix = `${SESSION_KIND_PREFIXES.bot}${bot.id}:`;
    let boundThreadId: string | null = null;
    let lastActivity = 0;
    for (const thread of threads) {
      if (!thread.id.startsWith(prefix)) continue;
      if (!boundThreadId || thread.updatedAt > lastActivity) {
        boundThreadId = thread.id;
        lastActivity = thread.updatedAt;
      }
    }
    contacts.push({
      agentId: bot.id,
      name: bot.name?.trim() || bot.id,
      title: bot.title?.trim() ?? '',
      description: bot.description?.trim() ?? '',
      model: bot.model?.trim() ?? '',
      avatarShape: bot.avatarShape,
      avatarColor: bot.avatarColor,
      boundThreadId,
      lastActivity,
    });
  }
  contacts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return contacts;
}

/**
 * Plan 483 P2: split contacts into the three sidebar lists and stamp the
 * `isPinned` / `isHidden` flags onto each entry (new object per contact;
 * the input array is untouched).
 *
 *  - `pinned`   — order follows `pinnedIds` (the persisted `sidebar.botPinnedIds`
 *                 array), which doubles as the drag-to-reorder store.
 *  - `unpinned` — every visible bot not in `pinnedIds`, name-sorted.
 *  - `hidden`   — bots in `hiddenIds`; rendered only in the "restore" view.
 */
export interface BotPartition {
  pinned: BotContact[];
  unpinned: BotContact[];
  hidden: BotContact[];
}

export function partitionBotContacts(
  contacts: BotContact[],
  pinnedIds: readonly string[],
  hiddenIds: readonly string[] = [],
): BotPartition {
  const hiddenSet = new Set(hiddenIds);
  const hidden: BotContact[] = [];
  const visible: BotContact[] = [];
  for (const contact of contacts) {
    if (hiddenSet.has(contact.agentId)) {
      hidden.push({ ...contact, isHidden: true, isPinned: false });
    } else {
      visible.push({ ...contact, isHidden: false });
    }
  }
  const pinned: BotContact[] = [];
  for (const id of pinnedIds) {
    const index = visible.findIndex((c) => c.agentId === id);
    if (index < 0) continue;
    pinned.push({ ...visible[index], isPinned: true, isHidden: false });
    visible.splice(index, 1);
  }
  const unpinned = visible.map((c) => ({ ...c, isPinned: false }));
  return { pinned, unpinned, hidden };
}

/** Avatar fallback label: first grapheme of the display name, uppercased. */
export function deriveBotAvatarLabel(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '·';
}

/**
 * Derive a legal bot id (`BOT_ID_PATTERN`: kebab-case, max 63 chars) from
 * a display name. Non-ASCII names (e.g. Chinese) collapse to `bot`;
 * collisions get `-2`, `-3`, … suffixes. Mirrors grok: ids are never
 * user-authored.
 */
export function deriveBotIdFromName(
  name: string,
  existingIds: Iterable<string>,
): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Non-ASCII names (e.g. Chinese) collapse to nothing; a lone digit or
  // 1-char remnant is too meaningless to serve as an identity — fall
  // back to the generic `bot` base in both cases.
  const base = slug.length >= 2 && !slug.startsWith('-') ? slug : 'bot';
  const finalBase = /^[a-z0-9][a-z0-9-]*$/.test(base)
    ? base.slice(0, 48).replace(/-+$/g, '') || 'bot'
    : 'bot';
  const taken = new Set(existingIds);
  let id = finalBase;
  let n = 2;
  while (taken.has(id)) {
    id = `${finalBase}-${n++}`;
  }
  return id;
}

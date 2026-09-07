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

import type { Message } from '@/types/message';
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
  /** Provider store id the configured `model` belongs to. */
  provider?: string;
  /** Thinking level bound to the model ('off'|'low'|'medium'|'high'); absent → runtime default medium. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  workspace?: string;
  avatarColor?: string;
  /** User-picked emoji for the colored circle (absent → deterministic per-agent emoji). */
  avatarEmoji?: string;
  /** `duya-file://` URL of the bot's avatar image (main-process built). */
  avatarUrl?: string;
}

export interface BotContact {
  /** Config agent id (`[agents.<id>]`), stable identity of the bot. */
  agentId: string;
  /** Display name (profile.json / config `name`, falling back to the id). */
  name: string;
  /** Role subtitle (profile.json only; not seeded from config). */
  title: string;
  description: string;
  model?: string;
  /** Provider store id the configured `model` belongs to. */
  provider?: string;
  /** Thinking level bound to the model ('off'|'low'|'medium'|'high'); absent → runtime default medium. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  /** Color token for the initial-circle avatar (image wins when present). */
  avatarColor?: string;
  /** User-picked emoji for the colored circle (wins over the deterministic one). */
  avatarEmoji?: string;
  /** `duya-file://` URL of the bot's avatar image; empty → colored circle. */
  avatarUrl?: string;
  /**
   * Thread id of the bot's bound persistent session
   * (`bot:<agentId>:<sessionId>`, plan 477 convention), or null while
   * no bound session exists in the local thread list.
   */
  boundThreadId: string | null;
  /** Latest activity of the bound session (0 when unbound). */
  lastActivity: number;
  /**
   * Latest user-visible message text (one line), or `undefined` when the
   * session has no messages yet, has only bot-internal rows, or has no
   * bound session. Mirrors grok-bot's `preview` field (rakazo reference):
   * "the most recent user-visible message in the bound session, sourced
   * from the same source filter that BotDirectChatView uses to render the
   * chat body." Trimmed + capped at 240 chars to keep the sidebar row
   * compact.
   */
  preview?: string;
  /** When `preview` was authored (timestamp ms). Used for tooltip ordering. */
  previewAt?: number;
  /**
   * Coarse activity status derived from stream phase + mailbox queue depth:
   *   - `idle`    — no active run AND no pending mailbox rows
   *   - `running` — stream session is in an active phase
   *   - `queued`  — user submitted a follow-up while another run was active
   *                 (mailbox.pending count > 0); runs first when the active
   *                 run reaches a safe checkpoint
   * Unbound contacts always read `idle`. The renderer subscribes to live
   * updates through `use-bot-contacts`; this field is the snapshot value.
   */
  status?: BotSessionStatus;
  /** Plan 483 P2: pinned to the top of the Bots section (ordered by `sidebar.botPinnedIds`). */
  isPinned?: boolean;
  /** Plan 483 P2: hidden from the sidebar (still configured; restorable). */
  isHidden?: boolean;
  /**
   * Sidebar group (section) the bot belongs to (rakazo-style folders,
   * persisted via `sidebar.botSections` + `sidebar.botSectionMembers`).
   * `undefined` while unassigned.
   */
  sectionId?: string;
}

/**
 * One user-defined bot sidebar group. The array position in
 * `sidebar.botSections` is the display order (append = creation order).
 */
export interface BotSectionDef {
  id: string;
  name: string;
}

/** One section partition: the section header plus its ordered members. */
export interface BotSectionPartition {
  section: BotSectionDef;
  contacts: BotContact[];
}

/** Coarse bot activity status for the sidebar row. */
export type BotSessionStatus = 'idle' | 'running' | 'queued';

const PREVIEW_MAX_CHARS = 240;

/**
 * Format a single-line preview snippet from message blocks. Mirrors the
 * "first text block" extraction in grok-bot's `previewFromBlocks` and
 * `BotDirectChatView`'s `textFromContent`. Collapses internal whitespace
 * so the sidebar row height is stable.
 */
export function previewTextFromContent(
  content: Message['content'] | Message['displayContent'],
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text);
    }
  }
  return parts.join('\n');
}

/**
 * Find the latest user-visible message in a transcript and return a
 * single-line preview string + timestamp.
 *
 * "User-visible" matches `BotDirectChatView`'s projection rules:
 *  - User rows: always visible (their `displayContent` is preferred so
 *    the sidebar shows the user's typed prompt, not synthetic context
 *    like the system prompt or attachment text).
 *  - Assistant rows: visible only when produced by SendMessage
 *    (`source === 'send_message'`), or when the older renderer
 *    convention is used (role=assistant + msgType undefined/text).
 *  - Tool / thinking / scratchpad / system rows: hidden. They are the
 *    bot's workspace, not its voice.
 *  - Compact boundaries, task notifications, queued `sending` rows are
 *    skipped silently.
 *
 * Returns `null` when no row qualifies (e.g. unbound session, empty
 * transcript, or transcript contains only bot-internal rows). The caller
 * decides how to render the absence.
 */
export interface BotPreviewSnapshot {
  text: string;
  timestamp: number;
}

export function peekBotMessagePreview(
  messages: readonly Message[] | undefined,
): BotPreviewSnapshot | null {
  if (!messages || messages.length === 0) return null;
  // Walk from the tail: the most recent qualifying row wins.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.isTaskNotification || message.isCompactBoundary) continue;
    if (message.role === 'user') {
      // Optimistic / failed follow-ups already show `sending`/`failed`
      // pills in the composer; the sidebar row mirrors that by skipping
      // rows the user has not finished submitting yet. The persisted
      // 'sent' row is what we want.
      if (message.status === 'sending' || message.status === 'failed') continue;
      const raw = previewTextFromContent(
        message.displayContent ?? message.content,
      ).trim();
      if (!raw) continue;
      return { text: clampPreview(raw), timestamp: message.timestamp };
    }
    if (message.role === 'assistant') {
      // Treat the new source taxonomy as canonical; fall back to the
      // legacy renderer convention (assistant + text/null msgType) when
      // `source` is absent so pre-P0.1 data still surfaces a preview.
      // Skip bot→bot DM marker cards (rendered as their own marker row
      // inside BotDirectChatView; would otherwise leak as "intent" text
      // into the sidebar preview).
      const source = (message.source ?? null) as string | null;
      // `agent_dm` rows are bot→bot DM marker cards (their own row type
      // inside BotDirectChatView). Drop them so the "intent" text does
      // not leak into the sidebar preview.
      const isDmMarker = source === 'agent_dm';
      const isVoiceBubble =
        source === 'send_message' ||
        source === 'user' ||
        (source == null &&
          (message.msgType == null || message.msgType === 'text'));
      if (!isVoiceBubble || isDmMarker) continue;
      const raw = previewTextFromContent(message.content).trim();
      if (!raw) continue;
      return { text: clampPreview(raw), timestamp: message.timestamp };
    }
    // tool / system rows are not part of the user-visible transcript.
  }
  return null;
}

function clampPreview(text: string): string {
  // Collapse internal whitespace so the sidebar row stays one line.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
  return collapsed.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + '…';
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
 * True when `threadId` belongs to this bot: the plan 477 P3.1 persistent
 * session is the BARE 2-part id `bot:<agentId>` (the placeholder and the
 * live session are the same id), while legacy/derived rows use the older
 * 3-part `bot:<agentId>:<sessionId>` shape. Both bind.
 */
export function matchesBotThread(agentId: string, threadId: string): boolean {
  const stem = `${SESSION_KIND_PREFIXES.bot}${agentId}`;
  return threadId === stem || threadId.startsWith(`${stem}:`);
}

/**
 * Resolve the thread id to open for a bot contact: prefer the bound
 * persistent session (`bot:<agentId>` or `bot:<agentId>:<sessionId>`),
 * fall back to the placeholder id (empty chat shell).
 */
export function resolveBotOpenThreadId(
  contact: BotContact,
  threads: Thread[],
): string {
  if (contact.boundThreadId) return contact.boundThreadId;
  const bound = threads.find((t) => matchesBotThread(contact.agentId, t.id));
  return bound?.id ?? deriveBotPlaceholderThreadId(contact.agentId);
}

/**
 * Build the contact list from the merged bot read side + the local
 * thread list. Contacts without a bound session still render (the user
 * can open the placeholder chat); sorting is by most recent activity
 * (persistent-session `updatedAt`, 0 when unbound), then by display
 * name case-insensitively (Telegram-style, like `buildRoomContacts`).
 */
export function buildBotContacts(
  bots: BotSource[],
  threads: Thread[],
  statusForThread?: (threadId: string | null) => BotSessionStatus | undefined,
): BotContact[] {
  const contacts: BotContact[] = [];
  for (const bot of bots) {
    if (!bot?.id) continue;
    let boundThreadId: string | null = null;
    let lastActivity = 0;
    for (const thread of threads) {
      if (!matchesBotThread(bot.id, thread.id)) continue;
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
      provider: bot.provider?.trim() || undefined,
      reasoning: bot.reasoning,
      avatarColor: bot.avatarColor,
      avatarEmoji: bot.avatarEmoji,
      avatarUrl: bot.avatarUrl,
      boundThreadId,
      lastActivity,
      status: statusForThread?.(boundThreadId),
    });
  }
  contacts.sort((a, b) => {
    // Recently-active bots first, then by display name (Telegram-style,
    // matching `buildRoomContacts`). Pinned/section orders are applied
    // later by `partitionBotContacts` and are not affected by this sort.
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return contacts;
}

/**
 * Plan 483 P2 (+ sections): split contacts into the sidebar lists and
 * stamp the `isPinned` / `isHidden` / `sectionId` flags onto each entry
 * (new object per contact; the input arrays are untouched).
 *
 *  - `pinned`     — order follows `pinnedIds` (the persisted
 *                   `sidebar.botPinnedIds` array), which doubles as the
 *                   drag-to-reorder store.
 *  - `sections`   — one group per `sections` entry (even when empty),
 *                   members in `sectionMembers[section.id]` order.
 *  - `unassigned` — every visible bot that is neither pinned nor in a
 *                   section, name-sorted (keeps the `buildBotContacts`
 *                   order).
 *  - `hidden`     — bots in `hiddenIds`; rendered only in the "restore"
 *                   view.
 *
 * Priority: hidden > pinned > section > unassigned. Pin/hide never
 * delete the section membership row, so unpinning or restoring a bot
 * returns it to its original group automatically.
 */
export interface BotPartition {
  pinned: BotContact[];
  sections: BotSectionPartition[];
  unassigned: BotContact[];
  hidden: BotContact[];
}

export function partitionBotContacts(
  contacts: BotContact[],
  pinnedIds: readonly string[],
  hiddenIds: readonly string[] = [],
  sections: readonly BotSectionDef[] = [],
  sectionMembers: Readonly<Record<string, readonly string[]>> = {},
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

  const sectionList: BotSectionPartition[] = [];
  for (const section of sections) {
    const members = sectionMembers[section.id] ?? [];
    const membersOfSection: BotContact[] = [];
    for (const memberId of members) {
      const index = visible.findIndex((c) => c.agentId === memberId);
      if (index < 0) continue;
      membersOfSection.push({
        ...visible[index],
        isPinned: false,
        isHidden: false,
        sectionId: section.id,
      });
      visible.splice(index, 1);
    }
    sectionList.push({ section, contacts: membersOfSection });
  }

  const unassigned = visible.map((c) => ({ ...c, isPinned: false }));
  return { pinned, sections: sectionList, unassigned, hidden };
}

/**
 * Append a new bot section (array order = display order). Returns the
 * minted section so the caller can assign bots to it immediately.
 */
export function createBotSection(
  sections: readonly BotSectionDef[],
  name: string,
): { sections: BotSectionDef[]; section: BotSectionDef } {
  const section: BotSectionDef = { id: crypto.randomUUID(), name: name.trim() };
  return { sections: [...sections, section], section };
}

/** Rename one section; other sections untouched. */
export function renameBotSection(
  sections: readonly BotSectionDef[],
  sectionId: string,
  name: string,
): BotSectionDef[] {
  return sections.map((section) =>
    section.id === sectionId ? { ...section, name: name.trim() } : section,
  );
}

/**
 * Remove a section and its membership row. Members silently become
 * unassigned (their contact entries keep rendering).
 */
export function deleteBotSection(
  sections: readonly BotSectionDef[],
  sectionMembers: Readonly<Record<string, readonly string[]>>,
  sectionId: string,
): { sections: BotSectionDef[]; sectionMembers: Record<string, string[]> } {
  const nextSections = sections.filter((section) => section.id !== sectionId);
  const nextMembers: Record<string, string[]> = {};
  for (const [id, members] of Object.entries(sectionMembers)) {
    if (id === sectionId) continue;
    nextMembers[id] = [...members];
  }
  return { sections: nextSections, sectionMembers: nextMembers };
}

/**
 * Assign a bot to a section (appended at the end) or unassign it
 * (`toSectionId === null`). Moving to another section removes the bot
 * from its current group first. Input is untouched; returns a new map.
 */
export function moveBotToSection(
  sectionMembers: Readonly<Record<string, readonly string[]>>,
  agentId: string,
  toSectionId: string | null,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [id, members] of Object.entries(sectionMembers)) {
    const without = members.filter((memberId) => memberId !== agentId);
    if (without.length > 0 || id !== toSectionId) next[id] = without;
  }
  if (toSectionId) {
    const current = next[toSectionId] ?? [];
    if (!current.includes(agentId)) next[toSectionId] = [...current, agentId];
  }
  return next;
}

/**
 * Reorder one section's members. ids missing from `orderedIds` keep
 * their relative order at the tail (tolerates stale member ids).
 */
export function reorderSectionBots(
  sectionMembers: Readonly<Record<string, readonly string[]>>,
  sectionId: string,
  orderedIds: readonly string[],
): Record<string, string[]> {
  const current = sectionMembers[sectionId] ?? [];
  const ordered = new Set(orderedIds);
  const rest = current.filter((id) => !ordered.has(id));
  const next: Record<string, string[]> = {};
  for (const [id, members] of Object.entries(sectionMembers)) {
    next[id] = id === sectionId ? [...orderedIds, ...rest] : [...members];
  }
  // Always materialize the target entry, even for a fresh section id.
  if (!(sectionId in next)) next[sectionId] = [...orderedIds, ...rest];
  return next;
}

/**
 * Reorder the sections themselves. ids missing from `orderedIds` keep
 * their existing relative order at the end.
 */
export function reorderSections(
  sections: readonly BotSectionDef[],
  orderedIds: readonly string[],
): BotSectionDef[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const orderedList: BotSectionDef[] = [];
  for (const id of orderedIds) {
    const section = byId.get(id);
    if (section) orderedList.push(section);
  }
  const ordered = new Set(orderedIds);
  const rest = sections.filter((section) => !ordered.has(section.id));
  return [...orderedList, ...rest];
}

/** Current section id of a bot, or null when unassigned. */
export function sectionOfBot(
  sectionMembers: Readonly<Record<string, readonly string[]>>,
  agentId: string,
): string | null {
  for (const [sectionId, members] of Object.entries(sectionMembers)) {
    if (members.includes(agentId)) return sectionId;
  }
  return null;
}

/** Avatar fallback label: first grapheme of the display name, uppercased. */
export function deriveBotAvatarLabel(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '·';
}

/**
 * Plan 478: one shared-room (group chat) row for the sidebar's 群聊 group.
 * Identity comes from `~/.duya/groups.toml` via the `config:groups:list`
 * IPC; the chat view is the room transcript session `room:<roomId>`.
 */
export interface RoomSource {
  id: string;
  name: string;
  memberIds: string[];
  memberNames: string[];
}

export interface RoomContact {
  /** Room id (`[groups.<id>]` key). */
  roomId: string;
  /** Display name of the room. */
  name: string;
  /** Member agent ids, in declaration order. */
  memberIds: string[];
  /** Member display names, aligned with memberIds. */
  memberNames: string[];
  /** Thread id of the room transcript session (`room:<roomId>`). */
  threadId: string;
  /** Latest activity of the room session (0 when it has no transcript yet). */
  lastActivity: number;
}

/** Thread id of a room transcript session (`room:<roomId>`). */
export function deriveRoomThreadId(roomId: string): string {
  return `${SESSION_KIND_PREFIXES.room}${roomId}`;
}

/**
 * Build the room contact list from the groups declaration + the local
 * thread list (for last-activity ordering). Name-sorted, like bot contacts.
 */
export function buildRoomContacts(rooms: RoomSource[], threads: Thread[]): RoomContact[] {
  const activityById = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.id.startsWith(SESSION_KIND_PREFIXES.room)) continue;
    activityById.set(thread.id, thread.updatedAt);
  }
  const contacts: RoomContact[] = [];
  for (const room of rooms) {
    if (!room?.id) continue;
    const threadId = deriveRoomThreadId(room.id);
    contacts.push({
      roomId: room.id,
      name: room.name?.trim() || room.id,
      memberIds: room.memberIds ?? [],
      memberNames: room.memberNames ?? [],
      threadId,
      lastActivity: activityById.get(threadId) ?? 0,
    });
  }
  contacts.sort((a, b) => {
    // Rooms with recent activity first, then by name (Telegram-style).
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return contacts;
}
// Bot id minting lives ONLY in the main process now (Plan 502: single
// minting point, grok agent-session.ts parity) — `config:agents:create`
// slugs the id from the display name and allocates it collision-free via
// allocateBotId. The old renderer-side deriveBotIdFromName duplicate is
// gone; its slug rules live in electron `slugifyBotIdFromName`.

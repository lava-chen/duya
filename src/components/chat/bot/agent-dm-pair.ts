/**
 * agent-dm-pair.ts — pure grouping/merge logic for bot↔bot DM UI (plan 497).
 *
 * Two consumers:
 *  - `buildAgentDmChipGroups`: collapses consecutive agent_dm marker rows in
 *    one bot-direct transcript into a single chip per burst (peer + count).
 *  - `buildAgentDmPairMessages`: merges the two sides of a 1:1 agent DM
 *    exchange into one chronological, deduplicated read-only transcript for
 *    the pair overlay. Each DM is persisted ONLY in its sender's session
 *    (direction 'sent'); the receiver's 'received' row is a mirror keyed by
 *    the same clientMsgId — so taking sent rows from both sessions yields
 *    each message exactly once, no cross-session dedupe needed. The dedupe
 *    below is defense-in-depth for duplicate persisted rows.
 *
 * Session-id scheme mirrors packages/agent bot-session-id.ts (a bot's
 * persistent session is `bot:<agentId>`); duplicated here so the renderer
 * does not pull the agent bundle into this code path.
 */

import type { AgentDmCardMeta, Message } from "@/types/message";

export const BOT_SESSION_ID_PREFIX = "bot:";

/** Derive a bot's persistent session id from its agent id. */
export function getBotSessionId(agentId: string): string {
  return `${BOT_SESSION_ID_PREFIX}${agentId}`;
}

/** Strip the `bot:` prefix; returns the agent id, or null for non-bot sessions. */
export function parseBotSessionAgentId(sessionId: string): string | null {
  return sessionId.startsWith(BOT_SESSION_ID_PREFIX)
    ? sessionId.slice(BOT_SESSION_ID_PREFIX.length)
    : null;
}

/** Plan 477 P4.4: bot→bot DM marker row (source agent_dm + card payload). */
export function isAgentDmMarkerMessage(message: DmMarkerRowLike): boolean {
  return message.source === "agent_dm";
}

/**
 * Canonical bot-direct display set (single source of truth for what renders
 * as a chat row in the bot surface). Deliberately excludes `reaction` (that
 * source only feeds the ingest store, never chat bubbles) and every hidden
 * source (`tool_use` / `thinking` / `system` / `scratchpad` / wake prompts).
 */
export const BOT_DIRECT_VISIBLE_SOURCES: ReadonlySet<string> = new Set([
  'send_message',
  'user',
  'agent_dm',
]);

/**
 * Plan 477 inbound agent-DM wake cue: `buildAgentInboundWakePrompt` opens with
 * this exact bootstrap line. A row carrying it is internal orchestration, not
 * chat content — hide it regardless of how the copy arrived.
 */
export function isInboundAgentWakeCue(message: DmMarkerRowLike): boolean {
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : "";
  return text.trimStart().startsWith(
    "[agent] A message just arrived from another of your user's agents:",
  );
}

/**
 * THE single bot-direct display predicate. Every surface (hook projection,
 * realtime merge, row builder) must branch on this alone — four separate
 * filters with divergent source sets are what let system/internal rows (agent
 * DM wake cues, compaction summaries) leak in as bubbles.
 */
export function isBotDirectDisplayable(m: DmMarkerRowLike): boolean {
  if (m.isTaskNotification) return false;
  if (m.isCompactSummary || m.isCompactBoundary) return false;
  if (isInboundAgentWakeCue(m)) return false;
  // Legacy unclassified rows (persisted before the source classifier, or fed
  // through the `messages` prop) carry no source yet still render as normal
  // bubbles — the internal-row guards above keep real leaks (wake cues,
  // compaction summaries) out regardless of source.
  if (m.source == null) return true;
  return BOT_DIRECT_VISIBLE_SOURCES.has(m.source);
}

/**
 * Structural row shape consumed here — satisfied by both the UI `Message`
 * (types/message.ts) and the wire `Message` (lib/ipc-client.ts, optional
 * timestamp), so the overlay can feed raw `getMessagesBySessionIPC` rows
 * without a lossy re-mapping.
 */
export interface DmMarkerRowLike {
  id: string;
  content: Message["content"];
  /** UI Message field (transcript rows). */
  timestamp?: number;
  /** Wire Message field (getMessagesBySessionIPC rows) — same instant. */
  createdAt?: number;
  source?: string | null;
  agentDmMeta?: AgentDmCardMeta | null;
  isTaskNotification?: boolean;
  isCompactSummary?: boolean;
  isCompactBoundary?: boolean;
}

/**
 * Row instant across both Message shapes: the transcript hook maps
 * createdAt → timestamp, but raw wire rows (pair overlay fetch) only carry
 * createdAt — falling through to 0 rendered "1970年1月1日 / 08:00".
 */
function tsOf(row: DmMarkerRowLike): number {
  return row.timestamp ?? row.createdAt ?? 0;
}

/**
 * Legacy received rows carry the sender's PERSISTENT SESSION id
 * (`bot:<agentId>`) as peerId while roster/pair addressing uses the bare
 * agent id — normalize so contact lookup, chip grouping and the pair-view
 * session derivation all resolve (a prefixed id rendered the wrong peer and
 * opened an empty pair view).
 */
function normalizePeerId(peerId: string): string {
  return parseBotSessionAgentId(peerId) ?? peerId;
}

/** Flatten message content blocks to plain text. */
export function textFromDmContent(
  content: Message["content"] | Message["displayContent"],
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}

/** Per-peer breakdown inside one chip burst (fan-out support). */
export interface AgentDmChipPeer {
  peerId: string;
  peerName: string;
  sentCount: number;
  receivedCount: number;
  count: number;
}

/** One collapsed chip: a run of consecutive agent_dm markers. */
export interface AgentDmChipGroup {
  /** Stable React key — first marker message id in the run. */
  key: string;
  /** Single-peer bursts: the peer id (multi-peer bursts read `peers`). */
  peerId: string;
  peerName: string;
  sentCount: number;
  receivedCount: number;
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
  /** Marker row ids in the run, in order — the view emits the chip at the
   *  first member's transcript position and drops the rest. */
  memberIds: string[];
  /** Per-peer breakdown in first-appearance order (grok's "N Bots" chip). */
  peers: AgentDmChipPeer[];
}

/**
 * Collapse consecutive agent_dm marker rows into ONE chip per run — peers
 * are NOT split: a fan-out burst (several peers back-to-back) collapses into
 * a single multi-peer chip (grok's "Messaged … 9 Bots"), while non-marker
 * transcript rows separate bursts chronologically.
 */
export function buildAgentDmChipGroups(messages: readonly DmMarkerRowLike[]): AgentDmChipGroup[] {
  const groups: AgentDmChipGroup[] = [];
  let current: AgentDmChipGroup | null = null;

  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };

  for (const message of messages) {
    if (!isAgentDmMarkerMessage(message)) {
      flush();
      continue;
    }
    const meta = message.agentDmMeta;
    if (!meta) continue;
    const sent = meta.direction === "sent";
    const peerId = normalizePeerId(meta.peerId);
    const peerName = meta.peerName || peerId;
    if (!current) {
      current = {
        key: `dm-group-${message.id}`,
        peerId,
        peerName,
        sentCount: 0,
        receivedCount: 0,
        count: 0,
        firstTimestamp: tsOf(message),
        lastTimestamp: tsOf(message),
        memberIds: [],
        peers: [],
      };
    }
    current.count += 1;
    if (sent) current.sentCount += 1;
    else current.receivedCount += 1;
    current.lastTimestamp = tsOf(message) || current.lastTimestamp;
    current.memberIds.push(message.id);
    let peer = current.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      peer = { peerId, peerName, sentCount: 0, receivedCount: 0, count: 0 };
      current.peers.push(peer);
    }
    peer.count += 1;
    if (sent) peer.sentCount += 1;
    else peer.receivedCount += 1;
  }
  flush();
  return groups;
}

/** One merged, read-only DM message in the pair overlay. */
export interface AgentDmPairEntry {
  /** clientMsgId when present, else the marker row id — stable React key. */
  key: string;
  /** The agent whose session this sent-marker lives in (the DM author). */
  senderAgentId: string;
  text: string;
  timestamp: number;
  intent?: string | null;
  priority?: boolean;
}

/**
 * Raw DM body for a marker row. New rows carry `meta.text`; legacy rows only
 * have the transcript content ("→ peer: text" for sent, "peer: text" for
 * received) — strip the known prefix as a fallback.
 */
export function textFromDmMarker(
  content: Message["content"],
  meta: AgentDmCardMeta,
): string {
  if (meta.text != null && meta.text.trim()) return meta.text;
  const raw = textFromDmContent(content).trim();
  const prefixes = [`→ ${meta.peerName}: `, `${meta.peerName}: `];
  for (const prefix of prefixes) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

/**
 * Merge the two halves of a 1:1 DM exchange: sent markers addressed to the
 * peer from this session + sent markers addressed to self from the peer's
 * session. Mirrors (direction 'received') are ignored — they duplicate the
 * same clientMsgId already covered by the sender's row. Display names are
 * resolved by the overlay (contacts), not here — a marker's peerName names
 * the RECEIVER, so it cannot label the sender row it lives on.
 */
export function buildAgentDmPairMessages(
  selfAgentId: string,
  peerAgentId: string,
  selfSessionMessages: readonly DmMarkerRowLike[],
  peerSessionMessages: readonly DmMarkerRowLike[],
): AgentDmPairEntry[] {
  const entries = new Map<string, AgentDmPairEntry>();

  const take = (messages: readonly DmMarkerRowLike[], senderAgentId: string) => {
    for (const message of messages) {
      if (!isAgentDmMarkerMessage(message)) continue;
      const meta = message.agentDmMeta;
      if (!meta) continue;
      if (meta.direction !== "sent") continue;
      const markerPeerId = normalizePeerId(meta.peerId);
      if (markerPeerId !== peerAgentId && markerPeerId !== selfAgentId) continue;
      const text = textFromDmMarker(message.content, meta).trim();
      if (!text) continue;
      const key = meta.clientMsgId || message.id;
      if (entries.has(key)) continue;
      entries.set(key, {
        key,
        senderAgentId,
        text,
        timestamp: tsOf(message),
        intent: meta.intent ?? null,
        priority: meta.priority ?? false,
      });
    }
  };

  // This session's markers for peer→? sends; the peer session's markers for
  // sends back to self. (take() checks both peer ids defensively — a session
  // only ever holds markers for its own sends to the OTHER side.)
  take(selfSessionMessages, selfAgentId);
  take(peerSessionMessages, peerAgentId);

  return Array.from(entries.values()).sort(
    (a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key),
  );
}

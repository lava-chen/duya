/**
 * channel-activity.ts — pure grouping/merge logic for the bot-direct chat's
 * channel chips (channel send/receive markers, companion to agent-dm-pair).
 *
 * Every channel message inbound to / outbound from the bot persists a
 * `channel_activity` marker row (SendMessageTool.deliverToChannel for out,
 * wakeForInbound for in). `buildChannelActivityChipGroups` collapses
 * CONSECUTIVE marker rows into one chip per burst — a run of mixed in/out
 * traffic across one or more channels merges into a single "与 XX 收发了
 * 消息" chip; any non-marker transcript row separates bursts chronologically.
 */

import type { ChannelActivityMeta, Message } from "@/types/message";

/** UI Message row carrying a channel marker payload. */
export interface ChannelMarkerRow {
  id: string;
  timestamp?: number;
  source?: string | null;
  channelMsgMeta?: ChannelActivityMeta | null;
}

export function isChannelActivityMarker(
  message: ChannelMarkerRow,
): boolean {
  return message.source === "channel_activity" && message.channelMsgMeta != null;
}

/** One collapsed chip: a run of consecutive channel markers. */
export interface ChannelActivityChipGroup {
  /** Stable React key — first marker message id in the run. */
  key: string;
  /** Marker row ids in the run, in order — the view emits the chip at the
   *  first member's transcript position and drops the rest. */
  memberIds: string[];
  /** Per-marker entries in transcript order (the detail overlay's body). */
  entries: Array<ChannelActivityMeta & { messageId: string; timestamp: number }>;
  /** Distinct platforms in first-appearance order (chip sentence). */
  platforms: string[];
  inCount: number;
  outCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

/**
 * Collapse consecutive channel marker rows into ONE chip per run.
 */
export function buildChannelActivityChipGroups(
  messages: readonly ChannelMarkerRow[],
): ChannelActivityChipGroup[] {
  const groups: ChannelActivityChipGroup[] = [];
  let current: ChannelActivityChipGroup | null = null;

  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };

  for (const message of messages) {
    if (!isChannelActivityMarker(message)) {
      flush();
      continue;
    }
    const meta = message.channelMsgMeta!;
    const platform = meta.platform || meta.address;
    if (!current) {
      current = {
        key: `channel-group-${message.id}`,
        memberIds: [],
        entries: [],
        platforms: [],
        inCount: 0,
        outCount: 0,
        firstTimestamp: message.timestamp ?? 0,
        lastTimestamp: message.timestamp ?? 0,
      };
    }
    if (!current.platforms.includes(platform)) {
      current.platforms.push(platform);
    }
    if (meta.direction === "in") current.inCount += 1;
    else current.outCount += 1;
    current.lastTimestamp = message.timestamp ?? current.lastTimestamp;
    current.memberIds.push(message.id);
    current.entries.push({
      ...meta,
      messageId: message.id,
      timestamp: message.timestamp ?? 0,
    });
  }
  flush();
  return groups;
}

/** Human platform label: "telegram" → "Telegram" (fallback: raw token). */
export function platformLabel(platform: string): string {
  if (!platform) return "";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

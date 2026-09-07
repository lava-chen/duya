"use client";

/**
 * GroupRoomChatView — shared-room (group chat) surface (Plan 478 P3.1).
 *
 * Mounted from App.tsx's renderView() as a sibling of BotDirectChatView —
 * the branch keys off `resolveChatMode(activeThreadId) === 'room'`, so
 * ChatView / the workspace pipeline never learn about room mode.
 *
 * Visual conventions follow rakazo's group chat (apps/web Shell.tsx):
 *   - user bubbles right-aligned, member bubbles left-aligned in muted
 *     chrome with a small speaker name line above the group-start row;
 *   - room lifecycle notices (group_system) render as centered system rows;
 *   - a composite group avatar (1 / 2 / 3+ member layouts) in the header;
 *   - the header carries a members subtitle and opens the group settings
 *     panel (member picker, GROUP_MEMBER_MAX 6) on click.
 *
 * Data flow is fully room-scoped (useRoomTranscript): the workspace
 * conversation store never sees `room:` sessions. Sends go through the
 * `room:post` IPC, which appends the user entry and schedules the group
 * turn — bot replies arrive through the `message:new` SSE broadcast.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { GroupCompositeAvatar } from "./GroupCompositeAvatar";
import { useRoomTranscript } from "./bot/use-room-transcript";
import { parseRoomIdFromSession, GROUP_MEMBER_MAX } from "@/lib/room-session";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types/message";

interface RoomMember {
  id: string;
  name: string;
  description?: string;
  avatarColor?: string;
  avatarUrl?: string;
}

interface RoomMeta {
  id: string;
  name: string;
  description?: string;
  members: RoomMember[];
}

/** Calendar-day key for grouping messages under date separators. */
function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

/** Separator label: locale date, year omitted when current. */
function dateSeparatorLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
}

function textFromContent(content: Message["content"] | Message["displayContent"]): string {
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

export interface GroupRoomChatViewProps {
  /** `room:<roomId>` session id. */
  sessionId: string;
}

export function GroupRoomChatView({ sessionId }: GroupRoomChatViewProps) {
  const { t } = useTranslation();
  const roomId = parseRoomIdFromSession(sessionId) ?? "";
  const { messages, isLoading, error } = useRoomTranscript(sessionId);
  const panel = useOptionalPanel() ?? null;

  const [room, setRoom] = useState<RoomMeta | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [awaitingReplies, setAwaitingReplies] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Room identity + members (room:members resolves names from the bot
  // roster; groups.get supplies the display name).
  const loadRoomMeta = useCallback(async () => {
    if (!roomId) return;
    try {
      await window.electronAPI?.room?.ensure?.(roomId);
      const members = ((await window.electronAPI?.room?.members?.(roomId)) ?? []) as RoomMember[];
      const declared = await window.electronAPI?.groups?.get?.(roomId);
      setRoom({
        id: roomId,
        name: declared?.name ?? roomId,
        description: declared?.description ?? "",
        members: members.map((m) => ({ ...m, description: m.description ?? "" })),
      });
    } catch {
      setRoom({ id: roomId, name: roomId, members: [] });
    }
  }, [roomId]);

  // Refresh room meta whenever the settings panel saves (name / description /
  // members) or deletes the room.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId === roomId) void loadRoomMeta();
    };
    window.addEventListener("duya:room-identity-updated", handler);
    return () => window.removeEventListener("duya:room-identity-updated", handler);
  }, [roomId, loadRoomMeta]);

  useEffect(() => {
    void loadRoomMeta();
  }, [loadRoomMeta]);

  // Auto-scroll to the newest row.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, awaitingReplies]);

  // Clear the "members are discussing" pill once any member speaks.
  const lastMemberPostAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant") return m.timestamp;
    }
    return 0;
  }, [messages]);
  useEffect(() => {
    if (!awaitingReplies) return;
    const timer = window.setTimeout(() => setAwaitingReplies(false), 90_000);
    return () => window.clearTimeout(timer);
  }, [awaitingReplies]);
  useEffect(() => {
    if (lastMemberPostAt > 0) setAwaitingReplies(false);
  }, [lastMemberPostAt]);

  // rakazo mention detection: `@` token at the caret's word start.
  const mentionCandidates = useMemo(() => {
    if (mentionQuery == null || !room) return [];
    const query = mentionQuery.toLowerCase();
    return room.members.filter(
      (m) =>
        m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query),
    );
  }, [mentionQuery, room]);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
  };

  const insertMention = (member: RoomMember) => {
    setDraft((prev) => prev.replace(/@([\w-]*)$/, `@${member.name} `));
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !roomId) return;
    setSending(true);
    try {
      await window.electronAPI?.room?.post?.(roomId, text);
      setDraft("");
      setMentionQuery(null);
      setAwaitingReplies(true);
    } finally {
      setSending(false);
    }
  }, [draft, sending, roomId]);

  const memberById = useMemo(() => {
    const map = new Map<string, RoomMember>();
    for (const member of room?.members ?? []) map.set(member.id, member);
    return map;
  }, [room]);

  // Compose the render rows: date separators + speaker grouping.
  const rows = useMemo(() => {
    const out: Array<
      | { kind: "date"; key: string; label: string }
      | { kind: "system"; key: string; text: string }
      | {
          kind: "bubble";
          key: string;
          role: "user" | "assistant";
          text: string;
          speaker?: RoomMember;
          isGroupStart: boolean;
          timestamp: number;
        }
    > = [];
    let lastDay = "";
    let lastSpeakerKey = "";
    for (const m of messages) {
      const text = textFromContent(m.displayContent ?? m.content).trim();
      if (!text) continue;
      const day = dayKeyOf(m.timestamp);
      if (day !== lastDay) {
        out.push({ kind: "date", key: `date-${m.id}`, label: dateSeparatorLabel(m.timestamp) });
        lastDay = day;
        lastSpeakerKey = "";
      }
      const source = m.source ?? null;
      if (source === "group_system") {
        out.push({ kind: "system", key: m.id, text });
        lastSpeakerKey = "";
        continue;
      }
      if (m.role === "user") {
        const speakerKey = "user";
        out.push({
          kind: "bubble",
          key: m.id,
          role: "user",
          text,
          isGroupStart: speakerKey !== lastSpeakerKey,
          timestamp: m.timestamp,
        });
        lastSpeakerKey = speakerKey;
        continue;
      }
      if (m.role === "assistant") {
        const member = m.groupPostMeta
          ? memberById.get(m.groupPostMeta.memberId) ?? {
              id: m.groupPostMeta.memberId,
              name: m.groupPostMeta.memberName || m.groupPostMeta.memberId,
            }
          : undefined;
        const speakerKey = member?.id ?? m.id;
        out.push({
          kind: "bubble",
          key: m.id,
          role: "assistant",
          text,
          speaker: member,
          isGroupStart: speakerKey !== lastSpeakerKey,
          timestamp: m.timestamp,
        });
        lastSpeakerKey = speakerKey;
      }
    }
    return out;
  }, [messages, memberById]);

  const membersSubtitle = room
    ? room.members.map((m) => m.name).join(", ")
    : "";

  return (
    <div className="bot-chat-view" data-testid="group-room-chat-view">
      <header className="bot-chat-header">
        <span className="bot-chat-header__avatar">
          <GroupCompositeAvatar members={room?.members ?? []} size={28} />
        </span>
        <span
          className="bot-chat-header__identity"
          onClick={() => {
            if (!roomId || !panel) return;
            // Toggle: clicking the header closes the settings panel when it
            // is already the active tab; otherwise open/activate it.
            const existing = panel.tabs.find(
              (t) => t.pageId === "room-settings" && t.params?.roomId === roomId,
            );
            if (existing && panel.activeTabId === existing.id) {
              panel.closePanel(existing.id);
              return;
            }
            panel.openOrActivatePage("room-settings", {
              roomId,
              title: room?.name ?? roomId,
            });
          }}
          role="button"
          tabIndex={0}
          aria-label={t("panel.roomSettings")}
        >
          <span className="bot-chat-header__name">{room?.name ?? roomId}</span>
          <span className="bot-chat-header__subtitle">
            {room ? `${room.members.length}/${GROUP_MEMBER_MAX} · ${membersSubtitle}` : ""}
          </span>
        </span>
        {awaitingReplies && <small className="bot-chat-header__working">成员讨论中…</small>}
      </header>

      <div className="bot-chat-transcript-wrap">
        <div ref={transcriptRef} className="bot-chat-transcript" data-testid="room-transcript">
          {isLoading && messages.length === 0 && (
            <div className="bot-chat-empty">
              <div className="bot-chat-empty__desc">加载中…</div>
            </div>
          )}
          {!isLoading && error && (
            <div className="bot-chat-empty">
              <div className="bot-chat-empty__desc">{error}</div>
            </div>
          )}
          {!isLoading && !error && messages.length === 0 && (
            <div className="bot-chat-empty">
              <GroupCompositeAvatar members={room?.members ?? []} size={44} />
              <div className="bot-chat-empty__name">{room?.name ?? roomId}</div>
              <div className="bot-chat-empty__desc">
                {room && room.members.length > 0
                  ? `与 ${membersSubtitle} 在同一房间讨论 — @成员 可以定向唤醒。`
                  : "群还没有成员 — 打开群聊设置添加。"}
              </div>
            </div>
          )}
          {rows.map((row) => {
            if (row.kind === "date") {
              return (
                <div key={row.key} className="flex justify-center py-1 text-[11.5px] text-[var(--text-muted)]">
                  {row.label}
                </div>
              );
            }
            if (row.kind === "system") {
              return (
                <div key={row.key} className="flex justify-center py-0.5 text-[12px] text-[var(--text-muted)]">
                  {row.text}
                </div>
              );
            }
            if (row.role === "user") {
              return (
                <div key={row.key} className="bot-chat-row bot-chat-row--user" data-role="user">
                  <div className="bot-chat-bubble bot-chat-bubble--group-start">{row.text}</div>
                </div>
              );
            }
            return (
              <div key={row.key} className="bot-chat-row bot-chat-row--assistant" data-role="assistant">
                <div className="bot-chat-row__stack">
                  {row.isGroupStart && (
                    <div className="flex items-center gap-1.5 pb-0.5">
                      {row.speaker && (
                        <BotCharacterAvatar
                          name={row.speaker.name}
                          agentId={row.speaker.id}
                          avatarColor={row.speaker.avatarColor}
                          avatarUrl={row.speaker.avatarUrl}
                          size={18}
                        />
                      )}
                      <span className="text-[12.5px] font-medium text-[var(--text-muted)]">
                        {row.speaker?.name ?? "成员"}
                      </span>
                    </div>
                  )}
                  <div className="bot-chat-bubble bot-chat-bubble--group-start">{row.text}</div>
                </div>
              </div>
            );
          })}
          {awaitingReplies && (
            <div className="bot-chat-typing" data-testid="room-typing">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>

      <div className="bot-chat-composer">
        <div className="bot-chat-composer__shell">
          {mentionCandidates.length > 0 && (
            <div
              className="mb-2 max-h-[180px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-canvas)]"
              data-testid="room-mention-list"
            >
              {mentionCandidates.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
                  onClick={() => insertMention(member)}
                >
                  <BotCharacterAvatar name={member.name} agentId={member.id} avatarColor={member.avatarColor} avatarUrl={member.avatarUrl} size={20} />
                  <span className="text-[13px] text-[var(--text)]">{member.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="bot-chat-composer__input-area">
            <textarea
              ref={textareaRef}
              className="bot-chat-composer__input"
              placeholder={`发消息到 ${room?.name ?? "群聊"}…（@成员 定向唤醒）`}
              value={draft}
              rows={1}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              data-testid="room-composer-input"
            />
          </div>
          <div className="bot-chat-composer__actions">
            <div className="bot-chat-composer__actions-left" />
            <div className="bot-chat-composer__actions-right">
              <button
                type="button"
                className="bot-chat-composer__send"
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                data-testid="room-composer-send"
              >
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

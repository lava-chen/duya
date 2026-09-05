"use client";

/**
 * BotDirectChatView — Telegram-style 1:1 chat with a bot (plan 483 P2.1,
 * UI aligned with grok-bot's chat stage).
 *
 * Mounted from App.tsx's renderView() as a SIBLING of ChatView (plan
 * 483 P2.1, mount corrected 2026-09-04): the branch keys off
 * `resolveChatMode(activeThreadId)` at the app-level view switch, so
 * ChatView / MessageList / the workspace pipeline never learn about
 * bot mode (plan §6 constraint "分支必须收敛"). The bot view is fully
 * self-contained: it does not run any ChatView hooks and receives the
 * transcript via props.
 *
 * Geometry and behavior borrowed from grok's transcript:
 *   - full-pane transcript column (screenshot 2026-09-05), 22px row gap
 *   - user rows right-aligned (`margin-inline-start: auto`), bot left
 *   - consecutive same-role messages group; group-start rows carry the
 *     bot avatar + name (grok keeps the header-only avatar; the plan
 *     spec asks for 头像+名字色 on the bubble container — group-start
 *     only, Telegram-style, is the merge of both)
 *   - 3-dot typing pill at the bottom while the agent streams
 *   - composer disabled until plan 477 binds a persistent session
 *
 * Out of scope here (later P2 items): tool/thinking collapse (P2.3),
 * cards (P2.2), send pipeline rewiring (P2.5 / plans 476+481) — onSend
 * rides the workspace handleSendMessage path. Plan 489 P0.3 (wired
 * 2026-09-05): the transcript now comes from the source-filtered
 * `useBotDirectTranscript` projection (send_message | user); the
 * messages prop only contributes in-flight optimistic user bubbles.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { BotComposer, type BotComposerSendPayload } from "./BotComposer";
import { BotBubbleRow } from "./BotBubbleRow";
import { BotToolCallRow } from "./BotToolCallRow";
import { BotThinkingRow } from "./BotThinkingRow";
import { BotTypingIndicator } from "./BotTypingIndicator";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types/message";

import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { resolveBotAgentId } from "./bot/chat-mode";
import { useBotDirectTranscript } from "./bot/use-bot-direct-transcript";
import { mergeInFlightOptimisticMessages } from "@/stores/conversation-store";

export interface BotDirectChatViewProps {
  sessionId: string;
  messages: Message[];
  isStreaming: boolean;
  isFinalizing: boolean;
  onSend: (payload: BotComposerSendPayload) => void;
  onStop: () => void;
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
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

interface BubbleRow {
  message: Message;
  role: "user" | "assistant";
  text: string;
  isGroupStart: boolean;
}

/** Text bubbles only; tool/thinking/system render as slim status rows. */
function isBubbleMessage(message: Message): message is Message & { role: "user" | "assistant" } {
  if (message.role !== "user" && message.role !== "assistant") return false;
  const type = message.msgType;
  return type == null || type === 'text';
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

/** Status rows: tool_call → BotToolCallRow, thinking → BotThinkingRow. */
function StatusRow({ message }: { message: Message }) {
  if (message.msgType === "thinking" && message.thinking) {
    return (
      <BotThinkingRow
        text={message.thinking}
        isStreaming={message.status === "streaming"}
      />
    );
  }
  if (message.msgType === "tool_use" && message.toolName) {
    return (
      <BotToolCallRow
        name={message.toolName}
        status={(message.status as "pending" | "running" | "done" | "failed" | "aborted") || "pending"}
        summary={typeof message.content === 'string' ? message.content.slice(0, 100) : undefined}
        toolInput={message.toolInput ?? undefined}
      />
    );
  }
  return null;
}

export function BotDirectChatView({
  sessionId,
  messages: messagesProp,
  isStreaming,
  isFinalizing,
  onSend,
  onStop,
}: BotDirectChatViewProps) {
  const { t } = useTranslation();
  const { allContacts: contacts } = useBotContacts();
  const agentId = resolveBotAgentId(sessionId);

  // Plan 489 P0.3 — bot-direct projection (wired 2026-09-05). The hook
  // returns the server-side source-filtered transcript (send_message |
  // user only); tool_use / thinking / scratchpad / system rows never
  // leave the main process. User rows need no filtering — anything with
  // source 'user' is visible by definition.
  //
  // The `messages` prop (conversation store) still matters for ONE thing:
  // the in-flight optimistic user bubble. The worker persists the user
  // row only at turn end, so between "send clicked" and "message:new
  // broadcast" the bubble lives solely in the store. Merge it in with
  // the shared logical-send dedupe (persisted rows win). When the IPC is
  // not wired (web build / jsdom tests) the hook bails out empty and the
  // prop transcript renders as-is.
  const { messages: persistedTranscript } = useBotDirectTranscript(sessionId);
  const ipcWired =
    typeof window !== "undefined" &&
    !!window.electronAPI?.message?.botDirectGetTranscript;
  const messages = useMemo(() => {
    if (!ipcWired) return messagesProp;
    return mergeInFlightOptimisticMessages(persistedTranscript, messagesProp).merged;
  }, [ipcWired, persistedTranscript, messagesProp]);

  const contact = useMemo(
    () => contacts.find((c) => c.agentId === agentId) ?? null,
    [contacts, agentId],
  );

  const botName = contact?.name ?? agentId ?? sessionId;
  const subtitle = contact?.title || contact?.description || "";
  // Plan 491 P1.2 / 477 P3.1: the persistent bot session is now lazily
  // created server-side on first send (`session:ensureBot`), so a 2-part
  // placeholder id (`bot:<agentId>`) is directly sendable — the old
  // boundThreadId (3-part) requirement permanently disabled the composer.
  // The bot only needs to exist in the configured roster.
  const canSendToBot = contact != null;
  const busy = isStreaming || isFinalizing;

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Plan 491 P0.4: scroll freeze detection
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Group consecutive same-role messages; a group start shows the bot
  // avatar + name (bot side only — user rows are compact, Telegram-style).
  const rows = useMemo<BubbleRow[]>(() => {
    const result: BubbleRow[] = [];
    let previousRole: string | null = null;
    for (const message of messages) {
      if (message.isTaskNotification) continue;
      if (isBubbleMessage(message)) {
        const text = textFromContent(
          message.role === "user" ? (message.displayContent ?? message.content) : message.content,
        );
        if (!text.trim()) continue;
        result.push({
          message,
          role: message.role,
          text,
          isGroupStart: previousRole !== message.role,
        });
        previousRole = message.role;
      } else {
        // Status row (tool/thinking/hook): does not reset bubble grouping —
        // an assistant text after its tool calls continues the same group.
        result.push({ message, role: "assistant", text: "", isGroupStart: false });
      }
    }
    return result;
  }, [messages]);

  // Plan 491 P0.4: scroll freeze detection
  const handleScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsScrolledUp(distanceFromBottom > 100);
  };

  // Follow new content like the workspace transcript does.
  // Plan 491 P0.4: only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && !isScrolledUp) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, isStreaming, isScrolledUp]);



  return (
    <div className="bot-chat-view">
      <header className="bot-chat-header">
        <span
          className="bot-chat-header__identity"
          title={subtitle || undefined}
        >
          <span className="bot-chat-header__avatar">
            <BotCharacterAvatar
              name={botName}
              agentId={agentId ?? sessionId}
              avatarShape={contact?.avatarShape}
              avatarColor={contact?.avatarColor}
              size={28}
            />
          </span>
          <span className="bot-chat-header__name">{botName}</span>
        </span>
        {busy && <small className="bot-chat-header__working">{t("bot.chat.working")}</small>}
      </header>

      <div className="bot-chat-transcript" ref={transcriptRef} role="log" aria-live="off" onScroll={handleScroll}>
        {rows.length === 0 && !busy ? (
          <div className="bot-chat-empty">
            <BotCharacterAvatar
              name={botName}
              agentId={agentId ?? sessionId}
              avatarShape={contact?.avatarShape}
              avatarColor={contact?.avatarColor}
              size={72}
            />
            <div className="bot-chat-empty__name">{botName}</div>
            {subtitle && <div className="bot-chat-empty__desc">{subtitle}</div>}
          </div>
        ) : (
          rows.map((row, index) => {
            // Date separator before the first row of each calendar day
            // (grok sand-transcript-time-separator).
            const previous = rows[index - 1];
            const showSeparator =
              previous == null ||
              dayKeyOf(previous.message.timestamp) !== dayKeyOf(row.message.timestamp);
            const element = row.text ? (
              <BotBubbleRow
                key={row.message.id}
                role={row.role}
                text={row.text}
              />
            ) : (
              <StatusRow key={row.message.id} message={row.message} />
            );
            return showSeparator ? (
              <React.Fragment key={row.message.id}>
                <div className="bot-chat-date-separator" role="separator">
                  {dateSeparatorLabel(row.message.timestamp)}
                </div>
                {element}
              </React.Fragment>
            ) : element;
          })
        )}
        {busy && <BotTypingIndicator />}

        {/* Plan 491 P0.4: jump to latest capsule */}
        {isScrolledUp && (
          <button
            className="bot-chat-jump-to-latest"
            onClick={() => {
              const el = transcriptRef.current;
              if (el) {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                setIsScrolledUp(false);
              }
            }}
            aria-label="Jump to latest"
          >
            <span className="bot-chat-jump-to-latest__icon">↓</span>
            <span>Jump to latest</span>
          </button>
        )}
      </div>

      <BotComposer
        botId={sessionId}
        disabled={!canSendToBot}
        busy={busy}
        onSend={onSend}
        onStop={onStop}
        placeholder={
          canSendToBot
            ? t("bot.chat.placeholder")
            : t("bot.chat.placeholderUnbound")
        }
      />
    </div>
  );
}

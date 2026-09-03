"use client";

/**
 * BotDirectChatView — Telegram-style 1:1 chat with a bot (plan 483 P2.1,
 * UI aligned with grok-bot's chat stage).
 *
 * Mounted via an early-return branch inside ChatView so ALL bot chat
 * logic stays in this file: MessageList / the workspace pipeline never
 * learn about bot mode (plan §6 constraint "分支必须收敛").
 *
 * Geometry and behavior borrowed from grok's transcript:
 *   - 690px centered transcript column, 22px row gap
 *   - user rows right-aligned (`margin-inline-start: auto`), bot left
 *   - consecutive same-role messages group; group-start rows carry the
 *     bot avatar + name (grok keeps the header-only avatar; the plan
 *     spec asks for 头像+名字色 on the bubble container — group-start
 *     only, Telegram-style, is the merge of both)
 *   - 3-dot typing pill at the bottom while the agent streams
 *   - composer disabled until plan 477 binds a persistent session
 *
 * Out of scope here (later P2 items): tool/thinking collapse (P2.3),
 * cards (P2.2), send pipeline rewiring (P2.5 / plans 476+481).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types/message";
import { useConversationStore } from "@/stores/conversation-store";
import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { resolveBotAgentId } from "./bot/chat-mode";

export interface BotDirectChatViewProps {
  sessionId: string;
  messages: Message[];
  isStreaming: boolean;
  isFinalizing: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
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

/** Compact status line for tool_use / thinking / system rows (P2.3 refines). */
function StatusRow({ message }: { message: Message }) {
  const label =
    message.msgType === "thinking"
      ? "…"
      : message.toolName
        ? `${message.toolName}`
        : "•";
  if (!label) return null;
  return (
    <div className="bot-chat-status-row" role="note">
      <span className="bot-chat-status-chip">{label}</span>
    </div>
  );
}

export function BotDirectChatView({
  sessionId,
  messages,
  isStreaming,
  isFinalizing,
  onSend,
  onStop,
}: BotDirectChatViewProps) {
  const { t } = useTranslation();
  const { contacts } = useBotContacts();
  const agentId = resolveBotAgentId(sessionId);
  const contact = useMemo(
    () => contacts.find((c) => c.agentId === agentId) ?? null,
    [contacts, agentId],
  );

  const botName = contact?.name ?? agentId ?? sessionId;
  const subtitle = contact?.title || contact?.description || "";
  const hasBoundSession = contact?.boundThreadId != null;
  const busy = isStreaming || isFinalizing;

  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

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

  // Follow new content like the workspace transcript does.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, isStreaming]);

  const canSend = hasBoundSession && draft.trim().length > 0 && !busy;

  const handleSend = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="bot-chat-view">
      <header className="bot-chat-header">
        <button
          type="button"
          className="bot-chat-header__back"
          onClick={() => useConversationStore.getState().setCurrentView('home')}
          aria-label={t("bot.chat.back")}
          title={t("bot.chat.back")}
        >
          <ArrowLeftIcon size={14} />
        </button>
        <span className="bot-chat-header__avatar">
          <BotCharacterAvatar
            name={botName}
            agentId={agentId ?? sessionId}
            avatarShape={contact?.avatarShape}
            avatarColor={contact?.avatarColor}
            size={28}
          />
        </span>
        <span className="bot-chat-header__identity">
          <span className="bot-chat-header__name">{botName}</span>
          {subtitle && <small className="bot-chat-header__subtitle">{subtitle}</small>}
        </span>
        {busy && <small className="bot-chat-header__working">{t("bot.chat.working")}</small>}
      </header>

      <div className="bot-chat-transcript" ref={transcriptRef} role="log" aria-live="off">
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
          rows.map((row) =>
            row.text ? (
              <div
                key={row.message.id}
                className={`bot-chat-row bot-chat-row--${row.role}`}
                data-group-start={row.isGroupStart || undefined}
              >
                {row.role === "assistant" && row.isGroupStart && (
                  <span className="bot-chat-row__gutter">
                    <BotCharacterAvatar
                      name={botName}
                      agentId={agentId ?? sessionId}
                      avatarShape={contact?.avatarShape}
                      avatarColor={contact?.avatarColor}
                      size={22}
                    />
                    <span className="bot-chat-row__name">{botName}</span>
                  </span>
                )}
                <div className="bot-chat-bubble">{row.text}</div>
              </div>
            ) : (
              <StatusRow key={row.message.id} message={row.message} />
            ),
          )
        )}
        {busy && (
          <div className="bot-chat-typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className="bot-chat-composer">
        <textarea
          className="bot-chat-composer__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            hasBoundSession
              ? t("bot.chat.placeholder")
              : t("bot.chat.placeholderUnbound")
          }
          disabled={!hasBoundSession}
          rows={1}
          aria-label={t("bot.chat.placeholder")}
        />
        {busy ? (
          <button
            type="button"
            className="bot-chat-composer__send bot-chat-composer__send--stop"
            onClick={onStop}
            aria-label={t("bot.chat.stop")}
            title={t("bot.chat.stop")}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="bot-chat-composer__send"
            onClick={handleSend}
            disabled={!canSend}
            aria-label={t("bot.chat.send")}
            title={t("bot.chat.send")}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

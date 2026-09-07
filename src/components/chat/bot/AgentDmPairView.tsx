"use client";

/**
 * AgentDmPairView — full-container read-only 1:1 conversation between two
 * bots (plan 497, grok's "Developer ⇌ Content Agent" as a SIBLING view of
 * BotDirectChatView, not a modal). Opened from the DM chips; the back arrow
 * returns to the bot chat. Message rows reuse BotBubbleRow: the current
 * bot's sends map to the user side (right), the peer's to assistant (left),
 * mirroring rakazo's PeerMessagesOverlay alignment.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { BotCharacterAvatar, botContactColorHex } from "@/components/layout/sidebar/BotCharacterAvatar";
import { BotBubbleRow } from "../BotBubbleRow";
import { resolveContactFor, type ContactSummaryLike } from "./agent-dm-contacts";
import { useAgentDmPairMessages } from "./use-agent-dm-pair";

interface AgentDmPairViewProps {
  selfAgentId: string;
  sessionId: string;
  selfName: string;
  selfAvatarUrl?: string;
  selfAvatarColor?: string;
  peerId: string;
  peerName: string;
  /** Return to the bot chat (App clears the pair state). */
  onBack: () => void;
}

/** Calendar-day key / label — same separators as the bot-direct transcript. */
function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

function daySeparatorLabel(timestamp: number): string {
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

export function AgentDmPairView({
  selfAgentId,
  sessionId,
  selfName,
  selfAvatarUrl,
  selfAvatarColor,
  peerId,
  peerName,
  onBack,
}: AgentDmPairViewProps) {
  const { t } = useTranslation();
  const { allContacts: contacts } = useBotContacts();
  const { entries, isLoading } = useAgentDmPairMessages({
    selfAgentId,
    peerAgentId: peerId,
    enabled: true,
  });

  // Follow new entries (initial open + live wake replies).
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const resolve = (agentId: string): ContactSummaryLike =>
    resolveContactFor(contacts, agentId, {
      selfAgentId,
      selfName,
      selfAvatarUrl,
      selfAvatarColor,
      fallbackPeerName: peerName,
    });

  const self = resolve(selfAgentId);
  const peer = resolve(peerId);

  // Every message (from either bot) sits on the LEFT with the author's
  // avatar + name above its bubble; the sender only decides which identity to
  // show, not the alignment. Rows reuse BotBubbleRow as a plain assistant row
  // (left-aligned, Markdown, hover bar) wrapped in an author header.
  const rows = useMemo(
    () =>
      entries.map((entry) => {
        const isSelf = entry.senderAgentId === selfAgentId;
        const sender = isSelf ? self : peer;
        return { entry, sender };
      }),
    [entries, self, peer],
  );

  return (
    <div className="bot-chat-view bot-dm-pair-view" data-peer={peerId}>
      <header className="bot-dm-pair-view__header">
        <button
          type="button"
          className="bot-dm-pair-view__back"
          onClick={onBack}
          aria-label={t("bot.chat.back")}
        >
          <ArrowLeftIcon size={18} strokeWidth={2} />
        </button>
        <div className="bot-dm-pair-view__stack" aria-hidden="true">
          <BotCharacterAvatar
            name={self.name}
            agentId={self.agentId}
            avatarUrl={self.avatarUrl}
            avatarColor={self.avatarColor}
            size={26}
          />
          <BotCharacterAvatar
            name={peer.name}
            agentId={peer.agentId}
            avatarUrl={peer.avatarUrl}
            avatarColor={peer.avatarColor}
            size={26}
          />
        </div>
        <div className="bot-dm-pair-view__title">
          <span className="bot-dm-pair-view__title-names">
            {self.name} · {peer.name}
          </span>
          <span className="bot-dm-pair-view__title-sub">
            {t("bot.dm.pairReadonly")}
          </span>
        </div>
      </header>

      <div className="bot-chat-transcript-wrap">
        <div className="bot-chat-transcript" ref={transcriptRef} role="log" aria-live="off">
          {entries.length === 0 && !isLoading && (
            <div className="bot-dm-pair-view__empty">{t("bot.dm.pairEmpty")}</div>
          )}
          {rows.map(({ entry, sender }, index) => {
            const previous = rows[index - 1];
            const showDay =
              index === 0 ||
              dayKeyOf(previous.entry.timestamp) !== dayKeyOf(entry.timestamp);
            const row = (
              <div key={entry.key} className="bot-dm-pair-row">
                <div className="bot-dm-pair-row__author">
                  <BotCharacterAvatar
                    name={sender.name}
                    agentId={sender.agentId}
                    avatarUrl={sender.avatarUrl}
                    avatarColor={sender.avatarColor}
                    size={20}
                  />
                  <span
                    className="bot-dm-pair-row__name"
                    style={{ color: botContactColorHex(sender.agentId, sender.avatarColor) ?? undefined }}
                  >
                    {sender.name}
                  </span>
                </div>
                <div className="bot-dm-pair-row__body">
                  <BotBubbleRow
                    role="assistant"
                    messageId={entry.key}
                    timestamp={entry.timestamp}
                    text={entry.text}
                  />
                </div>
              </div>
            );
            return showDay ? (
              <React.Fragment key={entry.key}>
                <div className="bot-chat-date-separator" role="separator">
                  {daySeparatorLabel(entry.timestamp)}
                </div>
                {row}
              </React.Fragment>
            ) : (
              row
            );
          })}
        </div>
      </div>

      <footer className="bot-dm-pair-view__footer">
        <span>
          {t("bot.dm.pairReadonly")} · {t("bot.dm.pairCount", { count: entries.length })}
        </span>
        <button type="button" className="bot-dm-pair-view__back-btn" onClick={onBack}>
          {t("bot.chat.back")}
        </button>
      </footer>
    </div>
  );
}

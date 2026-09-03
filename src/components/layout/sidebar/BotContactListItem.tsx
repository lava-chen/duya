"use client";

/**
 * BotContactListItem — Telegram-style contact row for one bot in the
 * sidebar Bots section (plan 483 P1.2).
 *
 * Renders the character avatar (grok-style shape × color via
 * BotCharacterAvatar; deterministic-hue initial fallback for legacy
 * agents) + display name + subtitle (title, else description), and a
 * busy dot that rides the bound session's stream phase
 * (`subscribeToPhase`, same source as ThreadListItem's running
 * indicator). Unbound contacts (no persistent session yet, plan 477
 * pending) simply stay idle.
 *
 * Unread badge: the mailbox counting source lands with plan 202 — the
 * CSS hook (`.bot-contact-unread`) is reserved but not rendered yet.
 */

import { useEffect, useState } from "react";
import { subscribeToPhase } from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types/message";
import { useTranslation } from "@/hooks/useTranslation";
import { BotCharacterAvatar } from "./BotCharacterAvatar";
import type { BotContact } from "./bot-contacts";

const ACTIVE_PHASES: StreamPhase[] = [
  "starting",
  "streaming",
  "awaiting_permission",
  "persisting",
];

interface BotContactListItemProps {
  contact: BotContact;
  isActive: boolean;
  onOpen: (contact: BotContact) => void;
}

export function BotContactListItem({ contact, isActive, onOpen }: BotContactListItemProps) {
  const { t } = useTranslation();
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!contact.boundThreadId) {
      setIsBusy(false);
      return;
    }
    const unsubscribe = subscribeToPhase(contact.boundThreadId, (phase) => {
      setIsBusy(ACTIVE_PHASES.includes(phase));
    });
    return unsubscribe;
  }, [contact.boundThreadId]);

  const subtitle = contact.title || contact.description;

  const handleOpen = () => onOpen(contact);

  return (
    <div
      className={`bot-contact-item${isActive ? " active" : ""}`}
      onClick={handleOpen}
      title={subtitle || contact.name}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleOpen();
        }
      }}
    >
      <BotCharacterAvatar
        name={contact.name}
        agentId={contact.agentId}
        avatarShape={contact.avatarShape}
        avatarColor={contact.avatarColor}
        size={26}
      />
      <span className="bot-contact-body">
        <span className="bot-contact-name">{contact.name}</span>
        {subtitle && (
          <span className="bot-contact-desc">{subtitle}</span>
        )}
      </span>
      {isBusy && (
        <span
          className="bot-contact-busy-dot"
          title={t("bot.contactBusy")}
          aria-label={t("bot.contactBusy")}
        />
      )}
    </div>
  );
}

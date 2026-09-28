import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotActivityStore } from "@/stores/bot-activity-store";
import { useBotDirectTranscript } from "@/components/chat/bot/use-bot-direct-transcript";
import { BotCharacterAvatar } from "./BotCharacterAvatar";
import { formatTimeAgo, peekBotMessagePreview, type BotContact } from "./bot-contacts";

interface RailBotAvatarProps {
  contact: BotContact;
  onOpen: () => void;
}

/**
 * Collapsed-rail bot entry: a 24px avatar button with a hover detail card.
 *
 * The card portals to `document.body` (the rail's `overflow: hidden` would
 * clip an absolutely-positioned child) and only mounts while hovered, so
 * the per-bot transcript subscription lives exactly as long as the card —
 * N rail avatars cost zero transcript subscriptions when idle. No hover
 * fill, active ring, or working ring: the avatar itself is the whole
 * visual; state is conveyed by the card's status line.
 */
export function RailBotAvatar({ contact, onOpen }: RailBotAvatarProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const erroredAt = useBotActivityStore((s) => s.erroredAt[contact.agentId]);
  const hasError = contact.status === "idle" && erroredAt != null;
  const running = contact.status === "running";

  const updateCardPos = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCardPos({
      // Vertically centered on the avatar, clamped so the card never leaves
      // the viewport (CSS translates it up by half its own height).
      top: Math.min(Math.max(rect.top + rect.height / 2, 120), window.innerHeight - 120),
      left: rect.right + 10,
    });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rail-bot"
        title={contact.name}
        aria-label={contact.name}
        onMouseEnter={() => {
          updateCardPos();
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onFocus={() => {
          updateCardPos();
          setHover(true);
        }}
        onBlur={() => setHover(false)}
        onClick={onOpen}
      >
        <span className="bot-contact-avatar-wrap">
          <BotCharacterAvatar
            name={contact.name}
            agentId={contact.agentId}
            avatarColor={contact.avatarColor}
            size={24}
          />
          {hasError && <span className="bot-contact-badge error" />}
        </span>
      </button>
      {hover && cardPos && (
        createPortal(
          <RailBotCard contact={contact} running={running} hasError={hasError} pos={cardPos} />,
          document.body,
        )
      )}
    </>
  );
}

/**
 * Card body. Mounted only while hovered — the transcript hook inside runs
 * exactly for the duration of the hover.
 */
function RailBotCard({
  contact,
  running,
  hasError,
  pos,
}: {
  contact: BotContact;
  running: boolean;
  hasError: boolean;
  pos: { top: number; left: number };
}) {
  const { t } = useTranslation();
  const { messages } = useBotDirectTranscript(contact.boundThreadId);
  const preview = peekBotMessagePreview(messages);

  const status = running
    ? t("bot.contactStatus.running")
    : hasError
      ? t("bot.contactBadgeError")
      : formatTimeAgo(t, contact.lastActivity);

  return (
    <div
      className="rail-bot-card"
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      role="tooltip"
    >
      <div className="rail-bot-card-head">
        <BotCharacterAvatar
          name={contact.name}
          agentId={contact.agentId}
          avatarColor={contact.avatarColor}
          size={30}
        />
        <span className="rail-bot-card-name">{contact.name}</span>
        <span className="rail-bot-card-status">{status}</span>
      </div>
      {(preview?.text || contact.description) && (
        <div className="rail-bot-card-preview">
          {preview?.text || contact.description}
        </div>
      )}
    </div>
  );
}

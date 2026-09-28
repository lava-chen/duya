import { useTranslation } from "@/hooks/useTranslation";
import { ArrowDownLeftIcon, ArrowUpRightIcon, XIcon } from "@/components/icons";
import {
  platformLabel,
  type ChannelActivityChipGroup,
} from "./channel-activity";

interface ChannelActivityChipProps {
  group: ChannelActivityChipGroup;
  /** Open the read-only detail overlay for this burst. */
  onOpen: (group: ChannelActivityChipGroup) => void;
}

/**
 * Collapsed channel send/receive chip in the bot-direct transcript (companion
 * to AgentDmGroupChip). One chip per burst of consecutive channel markers;
 * the sentence merges direction(s) and platform(s):
 *   从 Telegram 收到 3 条消息 / 发送了 2 条消息到 Feishu / 与 Telegram 收发了 5 条消息.
 * Click opens the read-only detail overlay (ChannelActivityOverlay).
 */
export function ChannelActivityChip({ group, onOpen }: ChannelActivityChipProps) {
  const { t } = useTranslation();
  const platforms = group.platforms.map(platformLabel).join("、");
  const count = group.entries.length;
  const sentence =
    group.outCount === 0
      ? t("bot.channel.chipIn", { platforms, count })
      : group.inCount === 0
        ? t("bot.channel.chipOut", { platforms, count })
        : t("bot.channel.chipBoth", { platforms, count });

  return (
    <div className="bot-chat-dm-chip-wrap">
      <button
        type="button"
        className="bot-chat-channel-chip"
        onClick={() => onOpen(group)}
        title={t("bot.channel.overlayTitle")}
      >
        {group.inCount > 0 && (
          <span className="bot-chat-channel-chip__icon bot-chat-channel-chip__icon--in">
            <ArrowDownLeftIcon size={12} />
          </span>
        )}
        {group.outCount > 0 && (
          <span className="bot-chat-channel-chip__icon bot-chat-channel-chip__icon--out">
            <ArrowUpRightIcon size={12} />
          </span>
        )}
        <span className="bot-chat-channel-chip__text">{sentence}</span>
      </button>
    </div>
  );
}

/**
 * Read-only detail overlay for one channel burst (the channel twin of the
 * agent-DM pair view). Renders as a full-container layer above the bot chat:
 * header with back arrow, then every marker of the burst in transcript order
 * with direction / platform / sender / time and the message body.
 */
export function ChannelActivityOverlay({
  group,
  onClose,
}: {
  group: ChannelActivityChipGroup;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const platforms = group.platforms.map(platformLabel).join("、");
  const count = group.entries.length;
  const title =
    group.outCount === 0
      ? t("bot.channel.chipIn", { platforms, count })
      : group.inCount === 0
        ? t("bot.channel.chipOut", { platforms, count })
        : t("bot.channel.chipBoth", { platforms, count });

  return (
    <div className="bot-chat-channel-overlay" role="dialog" aria-label={title}>
      <header className="bot-dm-pair-view__header">
        <button
          type="button"
          className="bot-dm-pair-view__back"
          onClick={onClose}
          aria-label={t("common.back")}
        >
          <XIcon size={14} />
        </button>
        <div className="bot-dm-pair-view__title">
          <span className="bot-dm-pair-view__title-names">{title}</span>
          <span className="bot-dm-pair-view__title-sub">
            {t("bot.channel.overlaySub")}
          </span>
        </div>
      </header>
      <div className="bot-chat-channel-overlay__body">
        {group.entries.map((entry) => {
          const isIn = entry.direction === "in";
          return (
            <div
              key={entry.messageId}
              className={`bot-chat-channel-entry${
                isIn ? " bot-chat-channel-entry--in" : " bot-chat-channel-entry--out"
              }`}
            >
              <div className="bot-chat-channel-entry__head">
                <span
                  className={`bot-chat-channel-entry__badge${
                    isIn ? " bot-chat-channel-entry__badge--in" : " bot-chat-channel-entry__badge--out"
                  }`}
                >
                  {isIn
                    ? t("bot.channel.inLabel")
                    : t("bot.channel.outLabel")}
                </span>
                <span className="bot-chat-channel-entry__platform">
                  {platformLabel(entry.platform)}
                </span>
                {isIn && entry.senderName && (
                  <span className="bot-chat-channel-entry__sender">
                    {entry.senderName}
                  </span>
                )}
                <span className="bot-chat-channel-entry__time">
                  {entry.timestamp > 0
                    ? new Date(entry.timestamp).toLocaleString()
                    : ""}
                </span>
              </div>
              {entry.text && (
                <div className="bot-chat-channel-entry__text">{entry.text}</div>
              )}
              {entry.url && (
                <div className="bot-chat-channel-entry__text bot-chat-channel-entry__text--url">
                  {entry.url}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

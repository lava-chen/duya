import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import type { AgentDmChipGroup, AgentDmChipPeer } from "./agent-dm-pair";

interface AgentDmGroupChipProps {
  group: AgentDmChipGroup;
  /** Resolve display identity for a peer (name/avatar from the roster). */
  resolvePeer: (peerId: string) => {
    name?: string;
    avatarUrl?: string;
    avatarColor?: string;
  };
  /** Open the read-only 1:1 pair overlay for one peer of the burst. */
  onOpenPeer: (peerId: string, peerName: string) => void;
}

/**
 * Plan 497 — collapsed bot↔bot DM chip in the bot-direct transcript
 * (rakazo's CollaborationMarker / grok's "Messaged …" pill). One chip per
 * burst of consecutive agent_dm markers:
 *  - single peer → click opens the pair overlay directly;
 *  - fan-out (multiple peers) → stacked avatars + "N bots"; click opens a
 *    small roster popover, clicking a row opens that pair's overlay.
 */
export function AgentDmGroupChip({ group, resolvePeer, onOpenPeer }: AgentDmGroupChipProps) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the fan-out popover on outside click / Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [popoverOpen]);

  const multi = group.peers.length > 1;
  const primary = group.peers[0];
  const primaryIdentity = resolvePeer(primary.peerId);
  const primaryName = primaryIdentity.name || primary.peerName;

  const label = multi
    ? t("bot.dm.chipMulti", { count: group.peers.length })
    : group.receivedCount === 0
      ? t("bot.dm.chipSent", { name: primaryName })
      : t("bot.dm.chipReceived", { name: primaryName });

  const handleActivate = () => {
    if (multi) setPopoverOpen((open) => !open);
    else onOpenPeer(primary.peerId, primary.peerName || primaryName);
  };

  return (
    <div className="bot-chat-dm-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className="bot-chat-dm-chip"
        data-peer={multi ? undefined : primary.peerId}
        data-direction={
          multi ? "multi" : group.receivedCount === 0 ? "sent" : "received"
        }
        onClick={handleActivate}
        title={t("bot.dm.pairReadonly")}
      >
        <span className="bot-chat-dm-chip__avatars" aria-hidden="true">
          {group.peers.slice(0, 3).map((peer) => {
            const identity = resolvePeer(peer.peerId);
            return (
              <span className="bot-chat-dm-chip__avatar" key={peer.peerId}>
                <BotCharacterAvatar
                  name={identity.name || peer.peerName}
                  agentId={peer.peerId}
                  avatarUrl={identity.avatarUrl}
                  avatarColor={identity.avatarColor}
                  size={16}
                />
              </span>
            );
          })}
        </span>
        <span className="bot-chat-dm-chip__label">{label}</span>
        <span className="bot-chat-dm-chip__count">
          {t("bot.dm.chipCount", { count: group.count })}
        </span>
      </button>

      {popoverOpen && (
        <div className="bot-chat-dm-chip__popover" role="menu">
          {group.peers.map((peer: AgentDmChipPeer) => {
            const identity = resolvePeer(peer.peerId);
            const name = identity.name || peer.peerName;
            return (
              <button
                key={peer.peerId}
                type="button"
                role="menuitem"
                className="bot-chat-dm-chip__popover-row"
                onClick={() => {
                  setPopoverOpen(false);
                  onOpenPeer(peer.peerId, peer.peerName || name);
                }}
              >
                <BotCharacterAvatar
                  name={name}
                  agentId={peer.peerId}
                  avatarUrl={identity.avatarUrl}
                  avatarColor={identity.avatarColor}
                  size={18}
                />
                <span className="bot-chat-dm-chip__popover-name">{name}</span>
                <span className="bot-chat-dm-chip__popover-count">
                  {t("bot.dm.chipCount", { count: peer.count })}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

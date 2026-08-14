"use client";

import {
  PlayCircleIcon,
  StopIcon,
  SpinnerGapIcon,
  LightningIcon,
  CircleNotchIcon,
  GearSixIcon,
} from "@/components/icons";
import { ChannelIcon, CHANNEL_COLORS } from "@/components/bridge/ChannelIcon";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import type {
  BridgeAdapter,
  BridgeStatus,
  ChannelId,
} from "@/components/bridge/channel-defs";
import { CHANNEL_METAS } from "@/components/bridge/channel-defs";

interface ConnectedChannelListProps {
  status: BridgeStatus | null;
  connectedChannels: ChannelId[];
  adapterMap: Map<string, BridgeAdapter>;
  sessionCount: number;
  controlling: boolean;
  onToggleBridge: () => void;
  onChannelClick: (id: ChannelId) => void;
  onSettingsClick: () => void;
}

export function ConnectedChannelList({
  status,
  connectedChannels,
  adapterMap,
  sessionCount,
  controlling,
  onToggleBridge,
  onChannelClick,
  onSettingsClick,
}: ConnectedChannelListProps) {
  const { t } = useTranslation();
  const isOrphaned = status?._orphaned ?? false;
  const isRunning = status?.running || isOrphaned;
  const connectedCount = status?.adapters.filter((a) => a.health?.connected).length ?? 0;

  const adapterFor = (id: ChannelId): BridgeAdapter | undefined =>
    adapterMap.get(id) ?? (id === "weixin" ? adapterMap.get("wechat") : undefined);

  const statusLabel = (id: ChannelId): string => {
    const adapter = adapterFor(id);
    if (adapter?.health?.connected) return t("bridge.connected");
    if (adapter?.running) return t("gateway.connecting");
    if (adapter?.error) return t("bridge.disconnected");
    return t("bridge.disconnected");
  };

  return (
    <section className="channel-list-section">
      {/* Bridge control header — the former status card, collapsed into the list */}
      <div className="channel-bridge-header">
        <div className="channel-bridge-status">
          <div className={`channel-bridge-orb ${isRunning ? "running" : "stopped"}`}>
            {isRunning ? <LightningIcon size={16} /> : <CircleNotchIcon size={16} />}
          </div>
          <div className="channel-bridge-info">
            <div className="channel-bridge-row">
              <span className={`channel-bridge-dot ${isRunning ? "running" : ""}`} />
              <span className="channel-bridge-text">
                {isRunning ? t("gateway.running") : t("gateway.stopped")}
              </span>
            </div>
            <span className="channel-bridge-subtext">
              {isRunning
                ? t("gateway.channelsConnected", { connected: connectedCount, total: status?.adapters.length ?? 0 })
                : t("gateway.offline")}
            </span>
          </div>
        </div>
        <div className="channel-bridge-actions">
          <span className="channel-bridge-stat">
            {sessionCount} {t("gateway.sessions")}
          </span>
          <Button
            variant={isRunning ? "danger" : "primary"}
            size="sm"
            className={`channel-bridge-toggle ${isRunning ? "stop" : "start"}`}
            onClick={onToggleBridge}
            disabled={controlling}
          >
            {controlling ? (
              <SpinnerGapIcon size={14} className="animate-spin" />
            ) : isRunning ? (
              <>
                <StopIcon size={14} />
                {t("gateway.stop")}
              </>
            ) : (
              <>
                <PlayCircleIcon size={14} />
                {t("gateway.startBridge")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Connected channel rows */}
      {connectedChannels.length === 0 ? (
        <div className="channel-list-empty">
          <p className="text-sm text-muted-foreground">{t("gateway.noConnectedChannels")}</p>
        </div>
      ) : (
        <ul className="channel-list">
          {connectedChannels.map((id) => {
            const meta = CHANNEL_METAS[id];
            const adapter = adapterFor(id);
            const isConnected = adapter?.health?.connected ?? false;
            return (
              <li key={id}>
                <div
                  role="button"
                  tabIndex={0}
                  className="channel-list-row"
                  onClick={() => onChannelClick(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChannelClick(id);
                    }
                  }}
                  title={t("gateway.viewSessions")}
                >
                  <div
                    className="channel-list-icon"
                    style={{
                      backgroundColor: CHANNEL_COLORS[id].bgColor,
                      color: CHANNEL_COLORS[id].color,
                    }}
                  >
                    <ChannelIcon channel={id} size={20} />
                  </div>
                  <div className="channel-list-name">
                    <span className="channel-list-name-text">{meta.name}</span>
                  </div>
                  <span className={`channel-list-dot ${isConnected ? "connected" : "disconnected"}`} />
                  <span className={`channel-list-status ${isConnected ? "connected" : "disconnected"}`}>
                    {statusLabel(id)}
                  </span>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t("gateway.openSettings")}
                    title={t("gateway.openSettings")}
                    className="channel-list-settings"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSettingsClick();
                    }}
                  >
                    <GearSixIcon size={15} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

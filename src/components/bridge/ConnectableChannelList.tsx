"use client";

import { PlusIcon } from "@/components/icons";
import { ChannelIcon, CHANNEL_COLORS } from "@/components/bridge/ChannelIcon";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import type { ChannelId } from "@/components/bridge/channel-defs";
import { CHANNEL_METAS } from "@/components/bridge/channel-defs";

interface ConnectableChannelListProps {
  connectableChannels: ChannelId[];
  onConnect: (id: ChannelId) => void;
}

export function ConnectableChannelList({
  connectableChannels,
  onConnect,
}: ConnectableChannelListProps) {
  const { t } = useTranslation();

  if (connectableChannels.length === 0) {
    return (
      <section className="channel-list-section">
        <div className="channel-list-empty">
          <p className="text-sm text-muted-foreground">{t("gateway.allChannelsConnected")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="channel-list-section">
      <ul className="channel-list">
        {connectableChannels.map((id) => {
          const meta = CHANNEL_METAS[id];
          return (
            <li key={id}>
              <div className="channel-list-row">
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
                <Button
                  variant="secondary"
                  size="sm"
                  className="channel-list-connect"
                  onClick={() => onConnect(id)}
                >
                  <PlusIcon size={14} />
                  {t("gateway.connect")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

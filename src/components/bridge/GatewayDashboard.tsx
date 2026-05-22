"use client";

import { useState, useCallback } from "react";
import { GearSixIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { GatewayStatusCard } from "./GatewayStatusCard";
import { ChannelStatusGrid } from "./ChannelStatusGrid";
import { GatewaySessionList } from "./GatewaySessionList";
import { GatewayChatModal } from "./GatewayChatModal";
import type { GatewaySession } from "@/lib/ipc-client";

export function GatewayDashboard() {
  const { t } = useTranslation();
  const { setCurrentView, setSettingsTab } = useConversationStore();
  const [selectedSession, setSelectedSession] = useState<GatewaySession | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  const handleSettingsClick = useCallback(() => {
    setSettingsTab("channels");
    setCurrentView("settings");
  }, [setCurrentView, setSettingsTab]);

  const handleChannelClick = useCallback(
    (channel: string) => {
      setSelectedChannel(channel);
    },
    []
  );

  const handleSessionClick = useCallback((session: GatewaySession) => {
    setSelectedSession(session);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedSession(null);
  }, []);

  return (
    <>
      <div className="gateway-dashboard">
        <div className="gateway-dashboard-main">
          <div className="gateway-dashboard-header">
            <h1 className="gateway-dashboard-title">
              {t("gateway.title")}
            </h1>
            <button
              className="gateway-settings-btn"
              onClick={handleSettingsClick}
              title={t("gateway.settings")}
            >
              <GearSixIcon size={18} />
            </button>
          </div>

          <GatewayStatusCard />

          <div className="gateway-section gateway-section-panels">
            <div className="gateway-panel gateway-panel-channels">
              <div className="gateway-panel-content">
                <ChannelStatusGrid
                  selectedChannel={selectedChannel}
                  onChannelClick={handleChannelClick}
                />
              </div>
            </div>
            <div className="gateway-panel gateway-panel-sessions">
              <div className="gateway-panel-content">
                <GatewaySessionList
                  selectedChannel={selectedChannel}
                  onSessionClick={handleSessionClick}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedSession && (
        <GatewayChatModal session={selectedSession} onClose={handleCloseModal} />
      )}
    </>
  );
}
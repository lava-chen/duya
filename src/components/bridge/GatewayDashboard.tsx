"use client";

import { useState, useCallback } from "react";
import { GearSixIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { GatewayStatusCard } from "./GatewayStatusCard";
import { GatewaySessionList } from "./GatewaySessionList";
import { ChannelStatusSidebar } from "./ChannelStatusSidebar";
import { GatewayChatModal } from "./GatewayChatModal";
import type { GatewaySession } from "@/lib/ipc-client";

export function GatewayDashboard() {
  const { t } = useTranslation();
  const { setCurrentView, setSettingsTab } = useConversationStore();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<GatewaySession | null>(null);

  const handleSettingsClick = useCallback(() => {
    setSettingsTab("channels");
    setCurrentView("settings");
  }, [setCurrentView, setSettingsTab]);

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
            <h1 className="gateway-dashboard-title gateway-title-copernicus">
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

          <div className="gateway-content-row">
            <ChannelStatusSidebar
              selectedChannel={selectedChannel}
              onChannelClick={setSelectedChannel}
            />
            <div className="gateway-section gateway-section-sessions">
              <GatewaySessionList
                selectedChannel={selectedChannel}
                onSessionClick={handleSessionClick}
              />
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

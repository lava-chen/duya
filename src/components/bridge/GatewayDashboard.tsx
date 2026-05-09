"use client";

import { useState, useCallback } from "react";
import { GearSixIcon, ServerIcon } from "@/components/icons";
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

  const handleSettingsClick = useCallback(() => {
    setSettingsTab("channels");
    setCurrentView("settings");
  }, [setCurrentView, setSettingsTab]);

  const handleChannelClick = useCallback(
    (channel: string) => {
      setSettingsTab("channels");
      setCurrentView("settings");
    },
    [setCurrentView, setSettingsTab]
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
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{
                  background: "linear-gradient(135deg, var(--accent) 0%, #9061f9 100%)",
                  boxShadow: "0 2px 8px var(--accent-shadow)",
                }}
              >
                <ServerIcon size={18} className="text-white" />
              </div>
              <div>
                <h1 className="gateway-dashboard-title">
                  {t("gateway.title")}
                </h1>
                <p className="gateway-dashboard-subtitle">
                  {t("gateway.subtitle")}
                </p>
              </div>
            </div>
            <button
              className="gateway-settings-btn"
              onClick={handleSettingsClick}
              title={t("gateway.settings")}
            >
              <GearSixIcon size={18} />
            </button>
          </div>

          <GatewayStatusCard />

          <div className="gateway-section">
            <div className="gateway-section-header">
              <span>{t("gateway.channels")}</span>
              <span
                className="gateway-section-badge"
                style={{
                  backgroundColor: "var(--surface)",
                  color: "var(--muted)",
                }}
              >
                {t("gateway.live")}
              </span>
            </div>
            <ChannelStatusGrid onChannelClick={handleChannelClick} />
          </div>

          <div className="gateway-section gateway-section-sessions">
            <div className="gateway-section-header">
              <span>{t("gateway.sessions")}</span>
            </div>
            <GatewaySessionList onSessionClick={handleSessionClick} />
          </div>
        </div>
      </div>

      {selectedSession && (
        <GatewayChatModal session={selectedSession} onClose={handleCloseModal} />
      )}
    </>
  );
}

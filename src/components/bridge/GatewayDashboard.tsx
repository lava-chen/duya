"use client";

import { useState, useEffect, useCallback } from "react";
import { GearSixIcon } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { ConnectedChannelList } from "./ConnectedChannelList";
import { ConnectableChannelList } from "./ConnectableChannelList";
import { ChannelConnectDialog } from "./ChannelConnectDialog";
import { ChannelSessionsDialog } from "./ChannelSessionsDialog";
import type {
  BridgeStatus,
  BridgeAdapter,
  ChannelId,
} from "./channel-defs";
import { ALL_CHANNEL_IDS } from "./channel-defs";

export function GatewayDashboard() {
  const { t } = useTranslation();
  const { setCurrentView, setSettingsTab } = useConversationStore();

  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlling, setControlling] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  // Dialog state
  const [connectChannel, setConnectChannel] = useState<ChannelId | null>(null);
  const [sessionsChannel, setSessionsChannel] = useState<ChannelId | null>(null);

  // ---- data fetching ----
  const fetchStatus = useCallback(async () => {
    try {
      const data = await window.electronAPI?.gateway?.getStatus();
      if (data) setStatus(data as BridgeStatus);
    } catch { /* ignore */ }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const allSettings = await window.electronAPI?.settingsDb?.getAll() as Record<string, string> | undefined;
      if (allSettings) setSettings(allSettings);
    } catch { /* ignore */ }
  }, []);

  const fetchSessionCount = useCallback(async () => {
    try {
      const sessions = await window.electronAPI?.gateway?.listSessions() as Array<unknown> | undefined;
      setSessionCount(sessions?.length ?? 0);
    } catch { /* ignore */ }
  }, []);

  const fetchAll = useCallback(() => {
    void Promise.all([fetchStatus(), fetchSettings(), fetchSessionCount()]);
  }, [fetchStatus, fetchSettings, fetchSessionCount]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ---- bridge control ----
  const toggleBridge = useCallback(async () => {
    setControlling(true);
    try {
      const isRunning = status?.running || status?._orphaned;
      if (isRunning) {
        const result = await window.electronAPI?.gateway?.stop();
        if (result && !(result as { success: boolean }).success) {
          throw new Error((result as { error?: string }).error || "Failed to stop gateway");
        }
      } else {
        const result = await window.electronAPI?.gateway?.start();
        if (result && !(result as { success: boolean }).success) {
          throw new Error((result as { error?: string }).error || "Failed to start gateway");
        }
      }
      await fetchStatus();
      await fetchSessionCount();
    } catch (err) {
      console.error("Bridge control error:", err);
    } finally {
      setControlling(false);
    }
  }, [status, fetchStatus, fetchSessionCount]);

  // ---- derived data ----
  const adapterMap = new Map<string, BridgeAdapter>(
    status?.adapters.map((a) => [a.platform, a]) ?? [],
  );

  // A channel is "connected" once it is enabled in settings (same rule as the
  // legacy ChannelStatusGrid). The red/green dot in each row reflects the live
  // adapter connectivity, not list membership.
  const connectedChannels: ChannelId[] = ALL_CHANNEL_IDS.filter((id) => {
    const enabledKey = `bridge_${id}_enabled`;
    return settings?.[enabledKey] === "true";
  });

  const connectableChannels: ChannelId[] = ALL_CHANNEL_IDS.filter((id) => {
    const enabledKey = `bridge_${id}_enabled`;
    return settings?.[enabledKey] !== "true";
  });

  const handleSettingsClick = useCallback(() => {
    setSettingsTab("channels");
    setCurrentView("settings");
  }, [setCurrentView, setSettingsTab]);

  const handleConnect = useCallback((id: ChannelId) => {
    setConnectChannel(id);
  }, []);

  const handleConnected = useCallback(() => {
    setConnectChannel(null);
    void fetchAll();
  }, [fetchAll]);

  const handleChannelClick = useCallback((id: ChannelId) => {
    setSessionsChannel(id);
  }, []);

  const handleCloseSessions = useCallback(() => {
    setSessionsChannel(null);
  }, []);

  return (
    <div className="gateway-dashboard">
      <div className="gateway-dashboard-main">
        <div className="gateway-dashboard-header">
          <h1 className="gateway-dashboard-title">{t("gateway.title")}</h1>
          <IconButton
            variant="default"
            size="lg"
            shape="square"
            aria-label={t("gateway.settings")}
            className="gateway-settings-btn"
            onClick={handleSettingsClick}
            title={t("gateway.settings")}
          >
            <GearSixIcon size={18} />
          </IconButton>
        </div>

        <div className="gateway-content gateway-content-columns">
          {/* Connected channels (upper list) */}
          <ConnectedChannelList
            status={status}
            connectedChannels={connectedChannels}
            adapterMap={adapterMap}
            sessionCount={sessionCount}
            controlling={controlling}
            onToggleBridge={toggleBridge}
            onChannelClick={handleChannelClick}
            onSettingsClick={handleSettingsClick}
          />

          {/* Divider */}
          <div className="channel-list-divider" />

          {/* Connectable channels (lower list) */}
          <ConnectableChannelList
            connectableChannels={connectableChannels}
            onConnect={handleConnect}
          />
        </div>
      </div>

      {connectChannel && (
        <ChannelConnectDialog
          channel={connectChannel}
          onClose={() => setConnectChannel(null)}
          onConnected={handleConnected}
        />
      )}

      {sessionsChannel && (
        <ChannelSessionsDialog
          channel={sessionsChannel}
          onClose={handleCloseSessions}
        />
      )}
    </div>
  );
}
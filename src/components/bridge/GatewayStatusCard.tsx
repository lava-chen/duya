"use client";

import { useState, useEffect, useCallback } from "react";
import {
  PlayCircleIcon,
  StopIcon,
  SpinnerGapIcon,
  LightningIcon,
  CircleNotchIcon,
  WarningIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { listGatewaySessionsIPC } from "@/lib/ipc-client";

interface AdapterHealth {
  connected: boolean;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  totalMessages: number;
  botUsername?: string;
}

interface BridgeStatus {
  running: boolean;
  adapters: Array<{
    channelType: string;
    running: boolean;
    lastMessageAt?: number;
    error?: string;
    health?: AdapterHealth;
  }>;
  autoStart: boolean;
  _orphaned?: boolean;
}

export function GatewayStatusCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [lastActivity, setLastActivity] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await window.electronAPI?.gateway?.getStatus();
      if (data) {
        setStatus(data as BridgeStatus);
      }
    } catch {
      // Ignore network errors
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSessionStats = useCallback(async () => {
    try {
      const sessions = await listGatewaySessionsIPC();
      setSessionCount(sessions.length);
      if (sessions.length > 0) {
        const latest = sessions.reduce((max, s) => (s.updatedAt > max.updatedAt ? s : max), sessions[0]);
        setLastActivity(latest.updatedAt);
      } else {
        setLastActivity(null);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchSessionStats();
    const interval = setInterval(() => {
      fetchStatus();
      fetchSessionStats();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchSessionStats]);

  const controlBridge = async (action: "start" | "stop") => {
    setControlling(true);
    setError(null);
    try {
      if (action === "start") {
        const result = await window.electronAPI?.gateway?.start();
        if (result && !(result as { success: boolean }).success) {
          throw new Error((result as { error?: string }).error || "Failed to start gateway");
        }
      } else {
        const result = await window.electronAPI?.gateway?.stop();
        if (result && !(result as { success: boolean }).success) {
          throw new Error((result as { error?: string }).error || "Failed to stop gateway");
        }
      }
      await fetchStatus();
      await fetchSessionStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to control gateway");
    } finally {
      setControlling(false);
    }
  };

  if (loading) {
    return (
      <div className="gateway-status-card">
        <div className="flex items-center justify-center gap-2 py-6">
          <SpinnerGapIcon size={18} className="animate-spin" />
          <span className="gateway-loading-text">{t("common.loading")}</span>
        </div>
      </div>
    );
  }

  const connectedCount = status?.adapters.filter((a) => a.health?.connected).length ?? 0;
  const totalAdapters = status?.adapters.length ?? 0;
  const isOrphaned = status?._orphaned ?? false;
  const displayRunning = status?.running || isOrphaned;

  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return t("gateway.daysAgo", { days });
    if (hours > 0) return t("gateway.hoursAgo", { hours });
    if (minutes > 0) return t("gateway.minutesAgo", { minutes });
    return t("gateway.justNow");
  };

  return (
    <div
      className="gateway-status-card"
      style={{
        background: displayRunning
          ? "linear-gradient(135deg, rgba(34, 197, 94, 0.04) 0%, var(--main-bg) 60%)"
          : "linear-gradient(135deg, rgba(124, 58, 237, 0.03) 0%, var(--main-bg) 60%)",
      }}
    >
      <div className="gateway-status-main">
        <div className="gateway-status-left">
          <div
            className={`gateway-status-orb ${displayRunning ? "running" : "stopped"}`}
          >
            {displayRunning ? <LightningIcon size={20} /> : <CircleNotchIcon size={20} />}
          </div>

          <div className="gateway-status-info">
            <div className="gateway-status-row">
              <span className={`gateway-status-dot ${displayRunning ? "running" : ""}`} />
              <span className="gateway-status-text">
                {isOrphaned ? `${t("gateway.running")}*` : displayRunning ? t("gateway.running") : t("gateway.stopped")}
              </span>
              {isOrphaned && (
                <span className="gateway-status-orphaned-badge">
                  {t("gateway.orphaned")}
                </span>
              )}
            </div>
            <span className="gateway-status-subtext">
              {displayRunning
                ? t("gateway.channelsConnected", { connected: connectedCount, total: totalAdapters })
                : t("gateway.offline")}
            </span>
          </div>
        </div>

        <button
          onClick={() => controlBridge(displayRunning ? "stop" : "start")}
          disabled={controlling}
          className={`gateway-control-button ${displayRunning ? "stop" : "start"}`}
        >
          {controlling ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : displayRunning ? (
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
        </button>
      </div>

      {error && (
        <div className="gateway-error-banner">
          <WarningIcon size={14} />
          {error}
        </div>
      )}

      {status?.running && (
        <div className="gateway-status-stats">
          <div className="gateway-stat">
            <span className="gateway-stat-value">{sessionCount}</span>
            <span className="gateway-stat-label">{t("gateway.sessions")}</span>
          </div>
          <div className="gateway-stat-divider" />
          <div className="gateway-stat">
            <span className="gateway-stat-value">{connectedCount}</span>
            <span className="gateway-stat-label">{t("gateway.connected")}</span>
          </div>
          <div className="gateway-stat-divider" />
          <div className="gateway-stat">
            <span className="gateway-stat-value">
              {status.adapters.reduce((sum, a) => sum + (a.health?.totalMessages ?? 0), 0)}
            </span>
            <span className="gateway-stat-label">{t("gateway.messages")}</span>
          </div>
          <div className="gateway-stat-divider" />
          <div className="gateway-stat">
            <span className="gateway-stat-value">
              {lastActivity ? formatRelativeTime(lastActivity) : "-"}
            </span>
            <span className="gateway-stat-label">{t("gateway.lastActivity")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

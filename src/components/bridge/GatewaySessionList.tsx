"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  SpinnerGapIcon,
  CircleNotchIcon,
  ChatCircleIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { listGatewaySessionsIPC, type GatewaySession } from "@/lib/ipc-client";
import { getSnapshot, subscribeToPhase } from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types/message";
import type { TranslationKey } from "@/i18n";

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

interface GatewaySessionListProps {
  onSessionClick: (session: GatewaySession) => void;
}

export function GatewaySessionList({ onSessionClick }: GatewaySessionListProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set());
  const unsubscribeRefs = useRef<Map<string, () => void>>(new Map());

  const fetchSessions = useCallback(async () => {
    try {
      const data = await listGatewaySessionsIPC();
      setSessions(data);

      const newActiveIds = new Set<string>();
      for (const session of data) {
        const snapshot = getSnapshot(session.id);
        if (snapshot && ACTIVE_PHASES.includes(snapshot.phase)) {
          newActiveIds.add(session.id);
        }
        const existingUnsubscribe = unsubscribeRefs.current.get(session.id);
        if (!existingUnsubscribe) {
          const unsubscribe = subscribeToPhase(session.id, (phase: StreamPhase) => {
            setActiveSessionIds((prev) => {
              const next = new Set(prev);
              if (ACTIVE_PHASES.includes(phase)) {
                next.add(session.id);
              } else {
                next.delete(session.id);
              }
              return next;
            });
          });
          unsubscribeRefs.current.set(session.id, unsubscribe);
        }
      }
      setActiveSessionIds(newActiveIds);
    } catch (err) {
      console.error("Failed to fetch gateway sessions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => {
      clearInterval(interval);
      unsubscribeRefs.current.forEach((unsubscribe) => unsubscribe());
      unsubscribeRefs.current.clear();
    };
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="gateway-session-loading">
        <SpinnerGapIcon size={16} className="animate-spin" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="gateway-session-empty">
        <ChatCircleIcon size={28} />
        <p>{t("gateway.noSessions")}</p>
        <span>{t("gateway.noSessionsDesc")}</span>
      </div>
    );
  }

  const activeSessions = sessions.filter((s) => activeSessionIds.has(s.id));
  const historySessions = sessions.filter((s) => !activeSessionIds.has(s.id));

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
    <div className="gateway-session-list">
      {activeSessions.length > 0 && (
        <div className="gateway-session-group">
          <div className="gateway-session-group-header">
            <span className="gateway-session-group-dot active" />
            <span className="gateway-session-group-title active">
              {t("gateway.active")} ({activeSessions.length})
            </span>
          </div>
          <div className="gateway-session-items">
            {activeSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive
                onClick={() => onSessionClick(session)}
                formatRelativeTime={formatRelativeTime}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {historySessions.length > 0 && (
        <div className="gateway-session-group">
          <div className="gateway-session-group-header">
            <span className="gateway-session-group-title">
              {t("gateway.history")} ({historySessions.length})
            </span>
          </div>
          <div className="gateway-session-items">
            {historySessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={false}
                onClick={() => onSessionClick(session)}
                formatRelativeTime={formatRelativeTime}
                t={t}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isActive,
  onClick,
  formatRelativeTime,
  t,
}: {
  session: GatewaySession;
  isActive: boolean;
  onClick: () => void;
  formatRelativeTime: (timestamp: number) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const getPlatformLabel = (platform: string): string => {
    const labels: Record<string, string> = {
      telegram: "TG",
      feishu: "FS",
      qq: "QQ",
      weixin: "WX",
      wechat: "WX",
    };
    return labels[platform] || platform.slice(0, 2).toUpperCase();
  };

  const getPlatformColor = (platform: string): string => {
    const colors: Record<string, string> = {
      telegram: "#3b82f6",
      feishu: "#3b82f6",
      qq: "#f97316",
      weixin: "#22c55e",
      wechat: "#22c55e",
      unknown: "var(--muted)",
    };
    return colors[platform] || "var(--muted)";
  };

  const platformColor = getPlatformColor(session.platform);
  const platformLabel = getPlatformLabel(session.platform);

  return (
    <button
      onClick={onClick}
      className={`gateway-session-item ${isActive ? "active" : ""}`}
    >
      <div
        className="gateway-session-platform-badge"
        style={{
          backgroundColor: `${platformColor}15`,
          color: platformColor,
        }}
      >
        {platformLabel}
      </div>

      <div className="gateway-session-info">
        <div className="gateway-session-title-row">
          <span className="gateway-session-title">
            {session.title || t("project.untitled")}
          </span>
          {isActive && (
            <span className="gateway-session-badge">
              <CircleNotchIcon size={8} className="animate-spin" />
              {t("gateway.streaming")}
            </span>
          )}
        </div>
        <span className="gateway-session-meta">
          {session.platform} · {formatRelativeTime(session.updatedAt)}
        </span>
      </div>
    </button>
  );
}

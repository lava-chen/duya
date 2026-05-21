"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  SpinnerGapIcon,
  CircleNotchIcon,
  ChatCircleIcon,
} from "@/components/icons";
import { ChannelIcon, CHANNEL_COLORS } from "./ChannelIcon";
import { useTranslation } from "@/hooks/useTranslation";
import { listGatewaySessionsIPC, type GatewaySession } from "@/lib/ipc-client";
import { getSnapshot, subscribeToPhase } from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types/message";
import type { TranslationKey } from "@/i18n";

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

interface GatewaySessionListProps {
  selectedChannel?: string | null;
  onSessionClick: (session: GatewaySession) => void;
}

export function GatewaySessionList({ selectedChannel, onSessionClick }: GatewaySessionListProps) {
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

  // Filter sessions by selected channel
  const filteredSessions = selectedChannel
    ? sessions.filter((s) => s.platform === selectedChannel || (selectedChannel === "weixin" && s.platform === "wechat"))
    : sessions;

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs" style={{ color: "var(--muted)" }}>
        <SpinnerGapIcon size={14} className="animate-spin" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  if (filteredSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" style={{ color: "var(--muted)" }}>
        <ChatCircleIcon size={20} style={{ opacity: 0.3 }} />
        <span className="text-xs">
          {selectedChannel ? t("gateway.noSessionsForChannel") : t("gateway.noSessions")}
        </span>
      </div>
    );
  }

  const activeSessions = filteredSessions.filter((s) => activeSessionIds.has(s.id));
  const historySessions = filteredSessions.filter((s) => !activeSessionIds.has(s.id));

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

  const getChannelInfo = (channel: string) => {
    const ch = channel === "wechat" ? "weixin" : channel;
    return {
      color: CHANNEL_COLORS[ch]?.color || "var(--muted)",
      bgColor: CHANNEL_COLORS[ch]?.bgColor || "var(--surface)",
    };
  };

  const headerChannel = selectedChannel || "weixin";
  const headerInfo = getChannelInfo(headerChannel);

  return (
    <div className="flex flex-col gap-4">
      <div className="session-list-header">
        <div
          className="session-list-header-icon"
          style={{
            backgroundColor: headerInfo.bgColor,
            color: headerInfo.color,
          }}
        >
          <ChannelIcon channel={headerChannel} size={20} />
        </div>
        <span className="session-list-header-title">{t("gateway.sessions")}</span>
      </div>

      {activeSessions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="session-section-header">
            <span className="session-section-dot active" />
            <span className="session-section-title active">
              {t("gateway.active")} ({activeSessions.length})
            </span>
          </div>
          <div className="flex flex-col">
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
        <div className="flex flex-col gap-1.5">
          <div className="session-section-header">
            <span className="session-section-title">
              {t("gateway.history")} ({historySessions.length})
            </span>
          </div>
          <div className="flex flex-col">
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
      className={`session-row ${isActive ? "active" : ""}`}
    >
      <span
        className="session-row-platform"
        style={{ color: platformColor }}
      >
        {platformLabel}
      </span>

      <div className="session-row-info">
        <span className="session-row-title">
          {session.title || t("project.untitled")}
        </span>
        <span className="session-row-meta">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </div>

      {isActive && (
        <span className="session-row-badge">
          <CircleNotchIcon size={8} className="animate-spin" />
        </span>
      )}
    </button>
  );
}

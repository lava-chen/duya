"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { XIcon, SpinnerGapIcon, ChatCircleIcon, CircleNotchIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { usePolling } from "@/hooks/usePolling";
import { listGatewaySessionsIPC, type GatewaySession } from "@/lib/ipc-client";
import { getSnapshot, subscribeToPhase } from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types/message";
import { GatewayChatModal } from "@/components/bridge/GatewayChatModal";
import type { ChannelId } from "@/components/bridge/channel-defs";
import { CHANNEL_METAS } from "@/components/bridge/channel-defs";
import type { TranslationKey } from "@/i18n";

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

interface ChannelSessionsDialogProps {
  channel: ChannelId;
  onClose: () => void;
}

function formatRelativeTime(timestamp: number, t: (key: TranslationKey) => string): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return t("gateway.daysAgo").replace("{days}", String(days));
  if (hours > 0) return t("gateway.hoursAgo").replace("{hours}", String(hours));
  if (minutes > 0) return t("gateway.minutesAgo").replace("{minutes}", String(minutes));
  return t("gateway.justNow");
}

export function ChannelSessionsDialog({ channel, onClose }: ChannelSessionsDialogProps) {
  const { t } = useTranslation();
  const meta = CHANNEL_METAS[channel];
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set());
  const [selectedSession, setSelectedSession] = useState<GatewaySession | null>(null);
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
              if (ACTIVE_PHASES.includes(phase)) next.add(session.id);
              else next.delete(session.id);
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

  // The dialog is conditionally mounted (only while open), so plain polling
  // without an activeWhen gate is enough. Immediate first tick on mount.
  usePolling(fetchSessions, 3000);

  // Release phase subscriptions on unmount (dialog close).
  useEffect(() => {
    return () => {
      unsubscribeRefs.current.forEach((unsubscribe) => unsubscribe());
      unsubscribeRefs.current.clear();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !selectedSession) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, selectedSession]);

  const filteredSessions = sessions.filter(
    (s) => s.platform === channel || (channel === "weixin" && s.platform === "wechat"),
  );
  const sortedSessions = [...filteredSessions].sort((a, b) => b.updatedAt - a.updatedAt);

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

  return (
    <div className="channel-dialog-overlay" onClick={selectedSession ? undefined : onClose}>
      <div
        className="channel-dialog channel-dialog-sessions"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-sessions-title"
      >
        {/* Header */}
        <div className="channel-dialog-header">
          <div className="flex items-center gap-2.5">
            <ChatCircleIcon size={16} className="text-accent" />
            <div className="flex flex-col">
              <span id="channel-sessions-title" className="text-sm font-medium">
                {t("gateway.channelSessions", { name: meta.name })}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {sortedSessions.length} {t("gateway.sessions")}
              </span>
            </div>
          </div>
          <button type="button" className="channel-dialog-close" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        {/* Session list */}
        <div className="channel-dialog-body channel-dialog-session-list">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <SpinnerGapIcon size={14} className="animate-spin" />
              {t("common.loading")}
            </div>
          ) : sortedSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
              <ChatCircleIcon size={22} className="opacity-30" />
              <span className="text-xs">{t("gateway.noSessionsForChannel")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {sortedSessions.map((session) => {
                const isActive = activeSessionIds.has(session.id);
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`session-row ${isActive ? "active" : ""}`}
                    onClick={() => setSelectedSession(session)}
                  >
                    <div className="session-row-info">
                      <span className="session-row-title">{session.title || t("project.untitled")}</span>
                      <span className="session-row-meta">
                        <span style={{ color: getPlatformColor(session.platform), fontWeight: 600 }}>
                          {session.platform.slice(0, 2).toUpperCase()}
                        </span>
                        <span>·</span>
                        <span>{formatRelativeTime(session.updatedAt, (k) => t(k))}</span>
                      </span>
                    </div>
                    {isActive && (
                      <span className="session-row-badge">
                        <CircleNotchIcon size={8} className="animate-spin" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedSession && (
        <GatewayChatModal session={selectedSession} onClose={() => setSelectedSession(null)} />
      )}
    </div>
  );
}

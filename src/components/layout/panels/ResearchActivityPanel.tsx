"use client";

import React, { useMemo, useState, useEffect } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { useResearchSession } from "@/hooks/useResearchSession";
import {
  MagnifyingGlassIcon,
  GlobeHemisphereWestIcon,
  LightningIcon,
  MagicWandIcon,
  NotePencilIcon,
  InfoIcon,
  XIcon,
  ClockCounterClockwiseIcon,
  CheckCircleIcon,
} from "@/components/icons";
import type { ResearchActivityItem, ResearchActivityKind } from "@/types/research";

const ICON_MAP: Record<ResearchActivityKind, React.ComponentType<{ size?: number }>> = {
  search: MagnifyingGlassIcon,
  browse: GlobeHemisphereWestIcon,
  source_found: GlobeHemisphereWestIcon,
  finding: LightningIcon,
  question_answered: CheckCircleIcon,
  milestone: MagicWandIcon,
  phase: InfoIcon,
  synthesis: NotePencilIcon,
  error: XIcon,
};

function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ActivityTimelineItem({ activity, isLast }: { activity: ResearchActivityItem; isLast: boolean }) {
  const IconComponent = ICON_MAP[activity.kind] || InfoIcon;
  const [showAllSources, setShowAllSources] = useState(false);

  const sources = activity.sources || [];
  const MAX_VISIBLE_SOURCES = 3;
  const visibleSources = showAllSources ? sources : sources.slice(0, MAX_VISIBLE_SOURCES);
  const hiddenCount = sources.length - MAX_VISIBLE_SOURCES;

  return (
    <div className="flex gap-3 relative">
      {/* Timeline vertical line */}
      <div className="flex-shrink-0 flex flex-col items-center" style={{ width: 20 }}>
        <div className="flex items-center justify-center" style={{ width: 20, height: 20 }}>
          <IconComponent size={14} />
        </div>
        {!isLast && (
          <div
            className="flex-1"
            style={{
              width: 1,
              minHeight: 12,
              backgroundColor: "var(--border)",
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-3">
        <div
          className="text-sm font-medium leading-snug"
          style={{ color: "var(--text)" }}
        >
          {activity.title}
        </div>
        {activity.detail && (
          <div
            className="text-xs mt-1 leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {activity.detail}
          </div>
        )}

        {/* Source chips */}
        {sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {visibleSources.map((src, i) => (
              <span
                key={`${src.url}-${i}`}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-xs"
                style={{
                  backgroundColor: "var(--surface)",
                  color: "var(--muted)",
                  border: "1px solid var(--border)",
                }}
              >
                {src.title || extractDomain(src.url)}
              </span>
            ))}
            {hiddenCount > 0 && !showAllSources && (
              <button
                onClick={() => setShowAllSources(true)}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-xs cursor-pointer"
                style={{
                  backgroundColor: "transparent",
                  color: "var(--accent)",
                  border: "1px solid var(--border)",
                }}
              >
                再显示 {hiddenCount} 个
              </button>
            )}
            {showAllSources && sources.length > MAX_VISIBLE_SOURCES && (
              <button
                onClick={() => setShowAllSources(false)}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-xs cursor-pointer"
                style={{
                  backgroundColor: "transparent",
                  color: "var(--accent)",
                  border: "1px solid var(--border)",
                }}
              >
                收起
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ResearchActivityPanel() {
  const { activeThreadId } = useConversationStore();
  const snapshot = useResearchSession(activeThreadId || "");

  const activities = snapshot.activities || [];
  const sorted = useMemo(() => {
    const arr = [...activities];
    arr.sort((a, b) => b.timestamp - a.timestamp);
    return arr;
  }, [activities]);

  const isActive = snapshot.active;

  // Elapsed time
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!snapshot.startedAt) {
      setElapsedMs(0);
      return;
    }
    const update = () => {
      const end = snapshot.completedAt || Date.now();
      setElapsedMs(end - snapshot.startedAt!);
    };
    update();
    if (isActive) {
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }
  }, [snapshot.startedAt, snapshot.completedAt, isActive]);

  if (!activeThreadId) {
    return (
      <div className="flex items-center justify-center h-full text-sm" style={{ color: "var(--muted)" }}>
        No active conversation
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
        {/* Tabs: 来源 / 活动 */}
        <div
          className="flex items-center rounded-md"
          style={{ backgroundColor: "var(--surface)" }}
        >
          <button
            className="px-2.5 py-1 text-xs rounded-md"
            style={{ color: "var(--muted)" }}
          >
            来源
          </button>
          <button
            className="px-2.5 py-1 text-xs rounded-md font-medium"
            style={{
              backgroundColor: "var(--bg-canvas)",
              color: "var(--text)",
              boxShadow: "0 0 0 1px var(--border)",
            }}
          >
            活动
          </button>
        </div>

        {/* Elapsed time */}
        {elapsedMs > 0 && (
          <div
            className="flex items-center gap-1 ml-auto text-xs"
            style={{ color: "var(--muted)" }}
          >
            <ClockCounterClockwiseIcon size={12} />
            <span>{formatElapsedTime(elapsedMs)}</span>
          </div>
        )}

        {/* Close button */}
        <button
          className="ml-1 flex items-center justify-center rounded hover:opacity-70"
          style={{ width: 24, height: 24, color: "var(--muted)" }}
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Activity timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {sorted.length === 0 ? (
          <div className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>
            {isActive ? "正在开始研究..." : "暂无活动记录"}
          </div>
        ) : (
          <div className="space-y-0">
            {sorted.map((activity, index) => (
              <ActivityTimelineItem
                key={activity.id}
                activity={activity}
                isLast={index === sorted.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
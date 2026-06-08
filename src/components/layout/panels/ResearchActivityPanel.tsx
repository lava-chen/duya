"use client";

import React, { useMemo, useState, useEffect } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { useResearchSession } from "@/hooks/useResearchSession";
import { usePanel } from "@/hooks/usePanel";
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
import type {
  ResearchActivityItem,
  ResearchActivityKind,
  ResearchActivitySource,
  ResearchSessionSnapshot,
} from "@/types/research";

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

interface SourceItem extends ResearchActivitySource {
  sourceType?: string;
  reliability?: string;
}

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

function parseActivityDetail(detail?: string): Record<string, unknown> | null {
  if (!detail) return null;
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function prettifyTitle(activity: ResearchActivityItem): string {
  const parsed = parseActivityDetail(activity.detail);
  const action = asText(parsed?.action);
  const query = asText(parsed?.query);
  const title = activity.title.replace(/^Next:\s*/i, "");

  if (activity.kind === "browse") return `Opened ${title}`;
  if (activity.kind === "source_found") return `Collected source: ${title.replace(/^Source:\s*/i, "")}`;
  if (activity.kind === "finding") return title.startsWith("Source:") ? title : `Found evidence: ${title}`;
  if (activity.kind === "question_answered") return `Answered: ${title.replace(/^Answered:\s*/i, "")}`;
  if (action) return `Next: ${action}`;
  if (query) return `Searching: ${query}`;
  return title;
}

function readableDetail(activity: ResearchActivityItem): string | null {
  const parsed = parseActivityDetail(activity.detail);
  if (!parsed) return activity.detail || null;

  return [
    asText(parsed.reason),
    asText(parsed.summary),
    asText(parsed.description),
    asText(parsed.query),
    asText(parsed.goal),
  ].find(Boolean) || null;
}

function sourceFromActivity(activity: ResearchActivityItem): SourceItem | null {
  const parsed = parseActivityDetail(activity.detail);
  const url = asText(parsed?.url) || activity.sources?.[0]?.url;
  if (!url) return null;
  return {
    url,
    title: asText(parsed?.title) || activity.sources?.[0]?.title || extractDomain(url),
  };
}

function collectSources(snapshot: ResearchSessionSnapshot): SourceItem[] {
  const map = new Map<string, SourceItem>();
  const add = (source: { url?: string | null; title?: string | null; sourceType?: string; reliability?: string }) => {
    if (!source.url) return;
    const key = source.url.trim();
    if (!key || map.has(key)) return;
    map.set(key, {
      url: key,
      title: source.title?.trim() || extractDomain(key),
      sourceType: source.sourceType,
      reliability: source.reliability,
    });
  };

  snapshot.persistedSources.forEach((source) => add({
    url: source.canonical_url || source.url,
    title: source.title,
    sourceType: source.source_type,
  }));
  snapshot.findings.forEach((finding) => add({
    url: finding.url,
    title: finding.title || finding.source,
    reliability: finding.sourceReliability,
  }));
  snapshot.activities.forEach((activity) => {
    activity.sources?.forEach((source) => add(source));
    const parsedSource = sourceFromActivity(activity);
    if (parsedSource) add(parsedSource);
  });

  return Array.from(map.values()).slice(0, 18);
}

function SourceStack({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) {
    return (
      <div className="rounded-xl px-3 py-4 text-sm" style={{ backgroundColor: "var(--surface)", color: "var(--muted)" }}>
        Sources will stack here as the agent opens pages, papers, and reports.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sources.map((source, index) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="group block rounded-xl px-3 py-2.5 transition-colors"
          style={{ backgroundColor: "var(--surface)" }}
        >
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px]"
              style={{ backgroundColor: "var(--bg-canvas)", color: "var(--muted)" }}
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium group-hover:underline" style={{ color: "var(--text)" }}>
                {source.title}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                <span>{extractDomain(source.url)}</span>
                {source.sourceType && <span>· {source.sourceType}</span>}
                {source.reliability && <span>· {source.reliability}</span>}
              </div>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

function ResearchNoteCard({ activity }: { activity: ResearchActivityItem }) {
  const IconComponent = ICON_MAP[activity.kind] || InfoIcon;
  const detail = readableDetail(activity);
  const source = sourceFromActivity(activity);

  return (
    <div className="rounded-xl px-3 py-3" style={{ backgroundColor: "var(--surface)" }}>
      <div className="flex items-start gap-2.5">
        <div
          className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: "var(--bg-canvas)", color: "var(--muted)" }}
        >
          <IconComponent size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug" style={{ color: "var(--text)" }}>
            {prettifyTitle(activity)}
          </div>
          {detail && (
            <div className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              {detail}
            </div>
          )}
          {source && (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-[11px]"
              style={{ backgroundColor: "var(--bg-canvas)", color: "var(--muted)" }}
            >
              <GlobeHemisphereWestIcon size={11} />
              <span className="truncate">{source.title}</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function CompactTimelineItem({ activity, isLast }: { activity: ResearchActivityItem; isLast: boolean }) {
  const IconComponent = ICON_MAP[activity.kind] || InfoIcon;
  const detail = readableDetail(activity);

  return (
    <div className="flex gap-3">
      <div className="flex flex-shrink-0 flex-col items-center" style={{ width: 20 }}>
        <div className="flex items-center justify-center" style={{ width: 20, height: 20 }}>
          <IconComponent size={13} />
        </div>
        {!isLast && <div className="flex-1" style={{ width: 1, minHeight: 10, backgroundColor: "var(--border)" }} />}
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="text-xs font-medium leading-snug" style={{ color: "var(--text)" }}>
          {prettifyTitle(activity)}
        </div>
        {detail && (
          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

export function ResearchActivityPanel() {
  const { activeThreadId } = useConversationStore();
  const { setPanelOpen } = usePanel();
  const snapshot = useResearchSession(activeThreadId || "");
  const [activeTab, setActiveTab] = useState<"sources" | "activity">("activity");

  const sorted = useMemo(() => {
    const arr = [...(snapshot.activities || [])];
    arr.sort((a, b) => b.timestamp - a.timestamp);
    return arr;
  }, [snapshot.activities]);

  const sources = useMemo(() => collectSources(snapshot), [snapshot]);

  const noteActivities = useMemo(() => sorted.filter((activity) => {
    if (activity.kind === "phase") return false;
    if (activity.title.startsWith("Complexity classified")) return false;
    return activity.kind === "finding"
      || activity.kind === "source_found"
      || activity.kind === "browse"
      || activity.kind === "question_answered"
      || activity.kind === "search"
      || activity.kind === "synthesis"
      || activity.title.startsWith("Next:");
  }).slice(0, 10), [sorted]);

  const isActive = snapshot.active;

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
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center rounded-md" style={{ backgroundColor: "var(--surface)" }}>
          <button
            type="button"
            className="px-2.5 py-1 text-xs rounded-md"
            style={{
              backgroundColor: activeTab === "sources" ? "var(--bg-canvas)" : "transparent",
              color: activeTab === "sources" ? "var(--text)" : "var(--muted)",
              boxShadow: activeTab === "sources" ? "0 0 0 1px var(--border)" : "none",
            }}
            onClick={() => setActiveTab("sources")}
          >
            Sources
          </button>
          <button
            type="button"
            className="px-2.5 py-1 text-xs rounded-md font-medium"
            style={{
              backgroundColor: activeTab === "activity" ? "var(--bg-canvas)" : "transparent",
              color: activeTab === "activity" ? "var(--text)" : "var(--muted)",
              boxShadow: activeTab === "activity" ? "0 0 0 1px var(--border)" : "none",
            }}
            onClick={() => setActiveTab("activity")}
          >
            Activity
          </button>
        </div>

        {elapsedMs > 0 && (
          <div className="flex items-center gap-1 ml-auto text-xs" style={{ color: "var(--muted)" }}>
            <ClockCounterClockwiseIcon size={12} />
            <span>{formatElapsedTime(elapsedMs)}</span>
          </div>
        )}

        <button
          type="button"
          className="ml-1 flex items-center justify-center rounded hover:opacity-70"
          style={{ width: 24, height: 24, color: "var(--muted)" }}
          onClick={() => setPanelOpen(false)}
          aria-label="Close research activity"
        >
          <XIcon size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {activeTab === "sources" ? (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                Source stack
              </div>
              <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Pages and papers the agent has opened or cited.
              </div>
            </div>
            <SourceStack sources={sources} />
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>
            {isActive ? "Research activity will appear here as the agent starts browsing." : "No research activity recorded yet."}
          </div>
        ) : (
          <div className="space-y-5">
            <section>
              <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                Research notes
              </div>
              <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Readable reasoning summaries, browsing steps, and interim findings.
              </div>
              <div className="mt-3 space-y-2">
                {noteActivities.length > 0 ? (
                  noteActivities.map((activity) => (
                    <ResearchNoteCard key={activity.id} activity={activity} />
                  ))
                ) : (
                  <div className="rounded-xl px-3 py-4 text-sm" style={{ backgroundColor: "var(--surface)", color: "var(--muted)" }}>
                    The agent is preparing the research plan. Notes will appear after the first search step.
                  </div>
                )}
              </div>
            </section>

            {snapshot.reportText && (
              <section>
                <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                  Live output
                </div>
                <div className="mt-2 rounded-xl px-3 py-3 text-xs leading-relaxed whitespace-pre-wrap" style={{ backgroundColor: "var(--surface)", color: "var(--muted)" }}>
                  {snapshot.reportText.slice(-900)}
                </div>
              </section>
            )}

            <section>
              <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                Timeline
              </div>
              <div className="mt-3">
                {sorted.slice(0, 14).map((activity, index) => (
                  <CompactTimelineItem
                    key={activity.id}
                    activity={activity}
                    isLast={index === Math.min(sorted.length, 14) - 1}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

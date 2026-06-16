"use client";

import { useEffect, useState } from "react";

import { useSettings } from "@/hooks/useSettings";
import { getWikiRuntimeStatusIPC, subscribeWikiActivityIPC } from "@/lib/memory-ipc";
import type { WikiRuntimeState } from "@/types/memory";

interface TitleBarProps {
  sidebarWidth?: number;
}

export function TitleBar({ sidebarWidth = 260 }: TitleBarProps) {
  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;
  const [wikiState, setWikiState] = useState<WikiRuntimeState>("idle");
  const [wikiSummary, setWikiSummary] = useState<string | null>(null);
  const [wikiUpdatedAt, setWikiUpdatedAt] = useState<number | null>(null);

  const { settings } = useSettings();
  const wikiAgentEnabled = settings?.wikiAgentEnabled === true;

  // Detect platform for window controls layout (macOS traffic lights on left, Windows on right)
  const isMac = window.electronAPI?.versions?.platform === "darwin";

  useEffect(() => {
    if (!wikiAgentEnabled) {
      setWikiState("idle");
      setWikiSummary(null);
      setWikiUpdatedAt(null);
      return;
    }

    let disposed = false;
    void getWikiRuntimeStatusIPC().then((status) => {
      if (!disposed) {
        setWikiState(status.state);
        setWikiSummary(status.summary);
        setWikiUpdatedAt(status.updatedAt);
      }
    });

    const unsubscribe = subscribeWikiActivityIPC((activity) => {
      if (activity.state) {
        setWikiState(activity.state);
      }
      if (activity.summary !== undefined) {
        setWikiSummary(activity.summary);
      }
      if (activity.timestamp) {
        setWikiUpdatedAt(activity.timestamp);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [wikiAgentEnabled]);

  const wikiLabel =
    wikiState === "processing"
      ? "WikiAgent active"
      : wikiState === "queued"
        ? "WikiAgent queued"
        : wikiState === "error"
          ? "WikiAgent error"
          : "WikiAgent idle";

  const wikiSecondaryLabel = wikiSummary
    ? wikiUpdatedAt
      ? `${wikiSummary} · ${new Date(wikiUpdatedAt).toLocaleTimeString()}`
      : wikiSummary
    : null;

  return (
    <div
      className={`titlebar-drag-region${isMac ? " is-mac" : " is-win"}`}
      style={{
        "--window-controls-offset": isMac ? "70px" : "0px",
      } as React.CSSProperties}
    >
      <div className="titlebar-brand">
        <img
          src={brandIconSrc}
          alt="DUYA"
          className="titlebar-logo"
        />
        <span className="titlebar-brand-text">Duya</span>
        <span
          className="titlebar-beta-badge"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: "4px",
            background: "var(--accent)",
            color: "white",
            marginLeft: "6px",
            letterSpacing: "0.5px",
          }}
        >
          BETA
        </span>
      </div>
      <div className="titlebar-spacer" style={{ width: sidebarWidth }} />
      <div className="titlebar-content-area">
        {wikiAgentEnabled && (
          <span
            className={`titlebar-wiki-status titlebar-wiki-status-${wikiState}`}
            title={wikiSecondaryLabel ? `${wikiLabel}\n${wikiSecondaryLabel}` : wikiLabel}
            aria-label={wikiLabel}
          >
            <span className="titlebar-wiki-status-dot" />
            <span className="titlebar-wiki-status-text">
              {wikiSecondaryLabel ? `${wikiLabel} · ${wikiSecondaryLabel}` : wikiLabel}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

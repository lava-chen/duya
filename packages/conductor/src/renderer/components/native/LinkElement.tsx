"use client";

import React, { useCallback, useEffect, useMemo } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { executeAction } from "../..//ipc/conductor-ipc";
import { useConversationStore } from "@/stores/conversation-store";

type LinkType = "url" | "session" | "canvas";

interface ParsedLinkConfig {
  linkType: LinkType;
  title?: string;
  description?: string;
  url?: string;
  faviconUrl?: string;
  siteName?: string;
  targetId?: string;
  expanded: boolean;
  expandedSize?: { w: number; h: number };
}

const LINK_META: Record<
  LinkType,
  { icon: string; badge: string; gradient: string; accent: string }
> = {
  url: {
    icon: "🌐",
    badge: "External URL",
    gradient: "linear-gradient(135deg, rgba(124,58,237,0.18), rgba(0,122,255,0.14))",
    accent: "#7c3aed",
  },
  session: {
    icon: "💬",
    badge: "DUYA Session",
    gradient: "linear-gradient(135deg, rgba(0,122,255,0.18), rgba(10,132,255,0.12))",
    accent: "#007aff",
  },
  canvas: {
    icon: "🎨",
    badge: "DUYA Canvas",
    gradient: "linear-gradient(135deg, rgba(34,197,94,0.16), rgba(0,122,255,0.12))",
    accent: "#22c55e",
  },
};

function parseLinkConfig(config: Record<string, unknown>): ParsedLinkConfig {
  const rawType = config.linkType;
  const linkType: LinkType = rawType === "session" || rawType === "canvas" ? rawType : "url";
  const expandedSize = isExpandedSize(config.expandedSize) ? config.expandedSize : undefined;

  return {
    linkType,
    title: typeof config.title === "string" ? config.title : undefined,
    description: typeof config.description === "string" ? config.description : undefined,
    url: typeof config.url === "string" ? config.url : undefined,
    faviconUrl: typeof config.faviconUrl === "string" ? config.faviconUrl : undefined,
    siteName: typeof config.siteName === "string" ? config.siteName : undefined,
    targetId: typeof config.targetId === "string" ? config.targetId : undefined,
    expanded: config.expanded === true,
    expandedSize,
  };
}

function isExpandedSize(value: unknown): value is { w: number; h: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.w === "number" && typeof record.h === "number";
}

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getDisplayTitle(config: ParsedLinkConfig): string {
  if (config.title) return config.title;
  if (config.linkType === "url") {
    if (config.url) return getDomainFromUrl(config.url);
    return "External Link";
  }
  if (config.targetId) return config.targetId.slice(0, 8);
  return config.linkType === "session" ? "Untitled Session" : "Untitled Canvas";
}

function getMetaLine(config: ParsedLinkConfig): string {
  if (config.linkType === "url") {
    return config.siteName || (config.url ? getDomainFromUrl(config.url) : "");
  }
  if (config.linkType === "session") {
    return config.description || "DUYA session";
  }
  return config.description || "DUYA canvas";
}

const chipBaseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 11px 7px 10px",
  borderRadius: 999,
  border: "1px solid var(--conductor-border)",
  background: "var(--surface)",
  boxShadow: "var(--shadow-resting)",
  cursor: "pointer",
  maxWidth: "100%",
  transition: "background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
};

const iconBubbleStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  flexShrink: 0,
};

const expandBtnStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  color: "var(--text-tertiary)",
  flexShrink: 0,
  transition: "background 0.15s ease, color 0.15s ease",
};

const buttonBaseStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontWeight: 600,
  padding: "7px 10px",
  borderRadius: "var(--radius-button)",
  border: "1px solid var(--conductor-border)",
  background: "var(--surface)",
  color: "var(--text-primary)",
  cursor: "pointer",
  transition: "background 0.15s ease",
};

export const LinkElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const config = useMemo(() => parseLinkConfig(element.config), [element.config]);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setActiveCanvas = useConductorStore((state) => state.setActiveCanvas);
  const setActiveThread = useConversationStore((state) => state.setActiveThread);

  const meta = LINK_META[config.linkType];
  const title = getDisplayTitle(config);
  const metaLine = getMetaLine(config);

  const handleOpen = useCallback(() => {
    if (config.linkType === "url") {
      const url = config.url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (config.linkType === "canvas") {
      if (config.targetId) setActiveCanvas(config.targetId);
      return;
    }
    if (config.linkType === "session") {
      if (config.targetId) setActiveThread(config.targetId);
      return;
    }
  }, [config, setActiveCanvas, setActiveThread]);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const text =
        config.linkType === "url"
          ? config.url || ""
          : `duya://${config.linkType}/${config.targetId || ""}`;
      void navigator.clipboard.writeText(text);
    },
    [config]
  );

  const toggleExpanded = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!activeCanvasId) return;

      const nextExpanded = !config.expanded;
      const nextPosition = nextExpanded
        ? config.expandedSize ?? { w: 5, h: 4 }
        : { w: 4, h: 1 };

      executeAction({
        action: "element.update",
        elementId: element.id,
        canvasId: activeCanvasId,
        position: {
          ...element.position,
          ...nextPosition,
        },
        config: {
          ...element.config,
          expanded: nextExpanded,
        },
      }).catch(() => {});
    },
    [activeCanvasId, config.expanded, config.expandedSize, element.config, element.id, element.position]
  );

  // Persist the user's resized dimensions for the expanded state.
  useEffect(() => {
    if (!config.expanded || !activeCanvasId) return;

    const currentW = element.position.w;
    const currentH = element.position.h;
    const storedW = config.expandedSize?.w;
    const storedH = config.expandedSize?.h;

    if (
      typeof currentW !== "number" ||
      typeof currentH !== "number" ||
      (currentW === storedW && currentH === storedH)
    ) {
      return;
    }

    executeAction({
      action: "element.update",
      elementId: element.id,
      canvasId: activeCanvasId,
      config: {
        ...element.config,
        expandedSize: { w: currentW, h: currentH },
      },
    }).catch(() => {});
  }, [
    activeCanvasId,
    config.expanded,
    config.expandedSize?.h,
    config.expandedSize?.w,
    element.config,
    element.id,
    element.position.h,
    element.position.w,
  ]);

  const chipStyle: React.CSSProperties = {
    ...chipBaseStyle,
    borderColor: config.expanded ? meta.accent : "var(--conductor-border)",
  };

  const chipIconStyle: React.CSSProperties = {
    ...iconBubbleStyle,
    background: `${meta.accent}1F`,
  };

  if (!config.expanded) {
    return (
      <div
        className="w-full h-full flex items-center"
        style={{ padding: "0 4px" }}
      >
        <div
          className="link-chip"
          style={chipStyle}
          onClick={(e) => {
            e.stopPropagation();
            handleOpen();
          }}
          onMouseEnter={(e) => {
            const target = e.currentTarget as HTMLDivElement;
            target.style.background = "var(--element-bg)";
            target.style.boxShadow = "var(--shadow-hovering)";
            target.style.borderColor = meta.accent;
          }}
          onMouseLeave={(e) => {
            const target = e.currentTarget as HTMLDivElement;
            target.style.background = "var(--surface)";
            target.style.boxShadow = "var(--shadow-resting)";
            target.style.borderColor = "var(--conductor-border)";
          }}
        >
          <span style={chipIconStyle}>{meta.icon}</span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            aria-label="Expand"
            style={expandBtnStyle}
            onClick={toggleExpanded}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = meta.accent;
              e.currentTarget.style.background = `${meta.accent}1F`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-tertiary)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            ▾
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{
        background: "var(--element-bg)",
        border: `1px solid ${meta.accent}`,
        borderRadius: "var(--radius-element)",
        boxShadow: "var(--shadow-hovering)",
      }}
    >
      <div
        style={{
          height: 80,
          background: meta.gradient,
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          padding: "12px 14px",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          aria-label="Collapse"
          onClick={toggleExpanded}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 24,
            height: 24,
            borderRadius: "50%",
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,0.85)",
            color: "#1d1d1f",
            fontSize: 14,
            cursor: "pointer",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}
        >
          ×
        </button>
        <span
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            background: "rgba(255,255,255,0.92)",
            color: "#1d1d1f",
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 6,
            boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
          }}
        >
          {meta.badge}
        </span>
        <span
          style={{
            ...iconBubbleStyle,
            width: 40,
            height: 40,
            borderRadius: 10,
            fontSize: 20,
            marginRight: 12,
            background: "rgba(255,255,255,0.92)",
            boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
          }}
        >
          {meta.icon}
        </span>
        <span
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: "#fff",
            textShadow: "0 1px 3px rgba(0,0,0,0.25)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col" style={{ padding: 14 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
            marginBottom: 12,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
          }}
        >
          {config.description || metaLine || "No description provided."}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            marginBottom: 14,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {meta.icon} {metaLine}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
          <button
            type="button"
            style={{ ...buttonBaseStyle, background: meta.accent, color: "#fff", borderColor: meta.accent }}
            onClick={(e) => {
              e.stopPropagation();
              handleOpen();
            }}
          >
            Open
          </button>
          <button type="button" style={buttonBaseStyle} onClick={handleCopy}>
            Copy
          </button>
        </div>
      </div>
    </div>
  );
};

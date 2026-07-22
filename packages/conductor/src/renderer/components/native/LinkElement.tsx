"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasElement } from "../../types/conductor";
import type { LinkSnapshotMode } from "../../types/canvas-node";
import { useConductorStore } from "../../stores/conductor-store";
import { executeAction, captureLinkSnapshot } from "../../ipc/conductor-ipc";
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
  snapshotMode: LinkSnapshotMode;
  snapshotAssetId?: string;
  snapshotUrl?: string;
}

const LINK_LABEL: Record<LinkType, string> = { url: "External link", session: "Conversation", canvas: "Canvas" };

const SNAPSHOT_MODES: { mode: LinkSnapshotMode; label: string; icon: string }[] = [
  { mode: "none", label: "Text link", icon: "↗" },
  { mode: "desktop-head", label: "Desktop · head", icon: "🖥" },
  { mode: "desktop-full", label: "Desktop · full page", icon: "🖥" },
  { mode: "mobile-head", label: "Mobile · head", icon: "📱" },
  { mode: "mobile-full", label: "Mobile · full page", icon: "📱" },
];

function isExpandedSize(value: unknown): value is { w: number; h: number } {
  if (!value || typeof value !== "object") return false;
  const size = value as Record<string, unknown>;
  return typeof size.w === "number" && typeof size.h === "number";
}

function parseLinkConfig(config: Record<string, unknown>): ParsedLinkConfig {
  const rawType = config.linkType;
  const legacyExpanded = typeof config.expanded === "boolean" ? config.expanded : undefined;
  const snapshotMode = (config.snapshotMode as LinkSnapshotMode) || (legacyExpanded ? "desktop-head" : "none");

  return {
    linkType: rawType === "canvas" || rawType === "session" ? rawType : "url",
    title: typeof config.title === "string" ? config.title : undefined,
    description: typeof config.description === "string" ? config.description : undefined,
    url: typeof config.url === "string" ? config.url : undefined,
    faviconUrl: typeof config.faviconUrl === "string" ? config.faviconUrl : undefined,
    siteName: typeof config.siteName === "string" ? config.siteName : undefined,
    targetId: typeof config.targetId === "string" ? config.targetId : undefined,
    snapshotMode,
    snapshotAssetId: typeof config.snapshotAssetId === "string" ? config.snapshotAssetId : undefined,
    snapshotUrl: typeof config.snapshotUrl === "string" ? config.snapshotUrl : undefined,
  };
}

function domainFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function titleFor(config: ParsedLinkConfig): string {
  if (config.title) return config.title;
  if (config.url) return domainFromUrl(config.url);
  return config.targetId?.slice(0, 8) || `Untitled ${LINK_LABEL[config.linkType].toLowerCase()}`;
}

function metaFor(config: ParsedLinkConfig): string {
  if (config.linkType === "url") return config.siteName || (config.url ? domainFromUrl(config.url) : "External URL");
  return config.description || LINK_LABEL[config.linkType];
}

function snapshotDimensions(mode: LinkSnapshotMode, imageWidth?: number, imageHeight?: number): { w: number; h: number } {
  switch (mode) {
    case "desktop-head":
      return { w: 6, h: 4 };
    case "desktop-full": {
      if (imageWidth && imageHeight) {
        const ratio = imageWidth / imageHeight;
        const h = Math.min(10, Math.max(4, 6 / ratio));
        return { w: 6, h };
      }
      return { w: 6, h: 8 };
    }
    case "mobile-head":
      return { w: 3, h: 5 };
    case "mobile-full": {
      if (imageWidth && imageHeight) {
        const ratio = imageWidth / imageHeight;
        const h = Math.min(12, Math.max(5, 3 / ratio));
        return { w: 3, h };
      }
      return { w: 3, h: 8 };
    }
    default:
      return { w: 4, h: 1 };
  }
}

function LinkMark({ type, faviconUrl }: { type: LinkType; faviconUrl?: string }) {
  if (type === "url" && faviconUrl) return <img className="canvas-link__favicon" src={faviconUrl} alt="" />;
  return <span className={`canvas-link__mark canvas-link__mark--${type}`}>{type === "url" ? "↗" : type === "canvas" ? "⌘" : "◌"}</span>;
}

function CanvasLinkPreview({ canvasId, title }: { canvasId?: string; title: string }) {
  const [elements, setElements] = React.useState<CanvasElement[]>([]);

  useEffect(() => {
    if (!canvasId) return;
    let cancelled = false;
    import("../../ipc/conductor-ipc").then(({ getSnapshot }) =>
      getSnapshot(canvasId)
        .then((snapshot) => {
          const targetElements = (snapshot as (typeof snapshot & { elements?: CanvasElement[] }) | null)?.elements ?? [];
          if (!cancelled) setElements(targetElements);
        })
        .catch(() => { if (!cancelled) setElements([]); }),
    );
    return () => { cancelled = true; };
  }, [canvasId]);

  const bounds = useMemo(() => {
    if (!elements.length) return { minX: 0, minY: 0, width: 1, height: 1 };
    const minX = Math.min(...elements.map((item) => item.position.x));
    const minY = Math.min(...elements.map((item) => item.position.y));
    const maxX = Math.max(...elements.map((item) => item.position.x + item.position.w));
    const maxY = Math.max(...elements.map((item) => item.position.y + item.position.h));
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }, [elements]);

  return <div className="canvas-link__preview" aria-label={`${title} canvas preview`}>
    <div className="canvas-link__preview-grid" />
    {elements.slice(0, 40).map((item) => {
      const left = ((item.position.x - bounds.minX) / bounds.width) * 72 + 14;
      const top = ((item.position.y - bounds.minY) / bounds.height) * 64 + 18;
      const width = Math.max(5, (item.position.w / bounds.width) * 72);
      const height = Math.max(4, (item.position.h / bounds.height) * 64);
      const kind = item.native_kind ?? item.elementKind.replace("native/", "");
      return <span key={item.id} className={`canvas-link__preview-node canvas-link__preview-node--${kind}`} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }} />;
    })}
    {!elements.length && <span className="canvas-link__preview-empty">Empty canvas</span>}
    <span className="canvas-link__preview-stats">{elements.length} {elements.length === 1 ? "element" : "elements"}</span>
  </div>;
}

function SnapshotModeMenu({
  currentMode,
  anchorRef,
  onSelect,
  onClose,
}: {
  currentMode: LinkSnapshotMode;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (mode: LinkSnapshotMode) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setStyle({ left: rect.left, top: rect.bottom + 4 });
  }, [anchorRef]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const menu = (
    <div ref={menuRef} className="canvas-link__mode-menu" style={{ left: style.left, top: style.top }}>
      {SNAPSHOT_MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          className={`canvas-link__mode-item${item.mode === currentMode ? " is-active" : ""}`}
          onClick={() => onSelect(item.mode)}
        >
          <span className="canvas-link__mode-icon">{item.icon}</span>
          <span className="canvas-link__mode-label">{item.label}</span>
        </button>
      ))}
    </div>
  );

  return createPortal(menu, document.body);
}

export const LinkElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const config = useMemo(() => parseLinkConfig(element.config), [element.config]);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setActiveCanvas = useConductorStore((state) => state.setActiveCanvas);
  const setActiveThread = useConversationStore((state) => state.setActiveThread);
  const title = titleFor(config);
  const meta = metaFor(config);

  const [menuOpen, setMenuOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const faviconButtonRef = useRef<HTMLButtonElement>(null);

  const open = useCallback(() => {
    if (config.linkType === "url" && config.url) window.open(config.url, "_blank", "noopener,noreferrer");
    if (config.linkType === "canvas" && config.targetId) setActiveCanvas(config.targetId);
    if (config.linkType === "session" && config.targetId) setActiveThread(config.targetId);
  }, [config, setActiveCanvas, setActiveThread]);

  const applyMode = useCallback(async (mode: LinkSnapshotMode) => {
    setMenuOpen(false);
    setCaptureError(null);

    if (!activeCanvasId) return;

    if (mode === "none") {
      const nextConfig = { ...element.config, snapshotMode: "none", snapshotAssetId: undefined, snapshotUrl: undefined };
      const size = snapshotDimensions("none");
      await executeAction({
        action: "element.update",
        elementId: element.id,
        canvasId: activeCanvasId,
        position: { ...element.position, ...size },
        config: nextConfig,
      });
      return;
    }

    if (config.linkType !== "url" || !config.url) return;

    setCapturing(true);
    try {
      const capture = await captureLinkSnapshot(activeCanvasId, element.id, config.url, mode);
      const size = snapshotDimensions(mode, capture.width, capture.height);
      const nextConfig = {
        ...element.config,
        snapshotMode: mode,
        snapshotAssetId: capture.assetId,
        snapshotUrl: capture.url,
      };
      await executeAction({
        action: "element.update",
        elementId: element.id,
        canvasId: activeCanvasId,
        position: { ...element.position, ...size },
        config: nextConfig,
      });
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setCapturing(false);
    }
  }, [activeCanvasId, config.linkType, config.url, element.config, element.id, element.position]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  }, [open]);

  const copy = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(config.linkType === "url" ? config.url || "" : `duya://${config.linkType}/${config.targetId || ""}`);
  }, [config]);

  if (config.linkType === "url" && config.snapshotMode !== "none") {
    return (
      <article className={`canvas-link canvas-link--snapshot canvas-link--snapshot-${config.snapshotMode}`} role="link" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="canvas-link__snapshot-frame" onClick={open}>
          {config.snapshotUrl ? (
            <img className="canvas-link__snapshot-image" src={config.snapshotUrl} alt={title} />
          ) : (
            <div className="canvas-link__snapshot-placeholder">
              <span className="canvas-link__snapshot-spinner" />
              <span>Loading snapshot…</span>
            </div>
          )}
          {capturing && (
            <div className="canvas-link__snapshot-overlay">
              <span className="canvas-link__snapshot-spinner" />
              <span>Capturing…</span>
            </div>
          )}
        </div>
        <footer className="canvas-link__snapshot-footer">
          <button
            ref={faviconButtonRef}
            type="button"
            className="canvas-link__snapshot-favicon-btn"
            onClick={(event) => { event.stopPropagation(); setMenuOpen((v) => !v); }}
            aria-label="Change snapshot mode"
          >
            {config.faviconUrl ? <img className="canvas-link__favicon" src={config.faviconUrl} alt="" /> : <span className="canvas-link__mark canvas-link__mark--url">↗</span>}
          </button>
          <button type="button" className="canvas-link__snapshot-title" onClick={open}>{title}</button>
          <button type="button" className="canvas-link__snapshot-copy" onClick={copy}>Copy</button>
        </footer>
        {captureError && <div className="canvas-link__snapshot-error">{captureError}</div>}
        {menuOpen && (
          <SnapshotModeMenu
            currentMode={config.snapshotMode}
            anchorRef={faviconButtonRef}
            onSelect={applyMode}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </article>
    );
  }

  if (config.linkType === "url") {
    return (
      <div className="canvas-link canvas-link--text" role="link" tabIndex={0} onKeyDown={onKeyDown}>
        <button
          ref={faviconButtonRef}
          type="button"
          className="canvas-link__favicon-btn"
          onClick={(event) => { event.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-label="Choose snapshot mode"
        >
          {config.faviconUrl ? <img className="canvas-link__favicon" src={config.faviconUrl} alt="" /> : <span className="canvas-link__mark canvas-link__mark--url">↗</span>}
        </button>
        <button type="button" className="canvas-link__title" onClick={open}>{title}</button>
        {menuOpen && (
          <SnapshotModeMenu
            currentMode={config.snapshotMode}
            anchorRef={faviconButtonRef}
            onSelect={applyMode}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    );
  }

  const isInternal = config.linkType !== "url";
  return (
    <article className={`canvas-link canvas-link--expanded canvas-link--${config.linkType}`} role="link" tabIndex={0} onKeyDown={onKeyDown} onClick={open}>
      {config.linkType === "canvas" && <CanvasLinkPreview canvasId={config.targetId} title={title} />}
      {isInternal && config.linkType === "session" && <div className="canvas-link__preview canvas-link__preview--session" aria-hidden="true"><span className="canvas-link__preview-empty">Conversation</span></div>}
      <header><LinkMark type={config.linkType} faviconUrl={config.faviconUrl} /><div><span className="canvas-link__eyebrow">{LINK_LABEL[config.linkType]}</span><h3>{title}</h3><p>{meta}</p></div></header>
      {config.description && <p className="canvas-link__description">{config.description}</p>}
      <footer><button type="button" onClick={copy}>Copy link</button><span>↗ Open</span></footer>
    </article>
  );
};

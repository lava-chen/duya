"use client";

import React, { useCallback, useEffect, useMemo } from "react";
import type { CanvasElement } from "../../types/conductor";
import { useConductorStore } from "../../stores/conductor-store";
import { executeAction } from "../../ipc/conductor-ipc";
import { getSnapshot } from "../../ipc/conductor-ipc";
import { useConversationStore } from "@/stores/conversation-store";

type LinkType = "url" | "session" | "canvas";

interface ParsedLinkConfig {
  linkType: LinkType; title?: string; description?: string; url?: string;
  faviconUrl?: string; siteName?: string; targetId?: string; expanded: boolean;
  expandedSize?: { w: number; h: number };
}

const LINK_LABEL: Record<LinkType, string> = { url: "External link", session: "Conversation", canvas: "Canvas" };

function isExpandedSize(value: unknown): value is { w: number; h: number } {
  if (!value || typeof value !== "object") return false;
  const size = value as Record<string, unknown>;
  return typeof size.w === "number" && typeof size.h === "number";
}

function parseLinkConfig(config: Record<string, unknown>): ParsedLinkConfig {
  const rawType = config.linkType;
  return {
    linkType: rawType === "canvas" || rawType === "session" ? rawType : "url",
    title: typeof config.title === "string" ? config.title : undefined,
    description: typeof config.description === "string" ? config.description : undefined,
    url: typeof config.url === "string" ? config.url : undefined,
    faviconUrl: typeof config.faviconUrl === "string" ? config.faviconUrl : undefined,
    siteName: typeof config.siteName === "string" ? config.siteName : undefined,
    targetId: typeof config.targetId === "string" ? config.targetId : undefined,
    expanded: typeof config.expanded === "boolean" ? config.expanded : rawType !== "url",
    expandedSize: isExpandedSize(config.expandedSize) ? config.expandedSize : undefined,
  };
}

function domainFromUrl(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function titleFor(config: ParsedLinkConfig): string {
  if (config.title) return config.title;
  if (config.url) return domainFromUrl(config.url);
  return config.targetId?.slice(0, 8) || `Untitled ${LINK_LABEL[config.linkType].toLowerCase()}`;
}
function metaFor(config: ParsedLinkConfig): string {
  if (config.linkType === "url") return config.siteName || (config.url ? domainFromUrl(config.url) : "External URL");
  return config.description || LINK_LABEL[config.linkType];
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
    getSnapshot(canvasId)
      .then((snapshot) => {
        const targetElements = (snapshot as (typeof snapshot & { elements?: CanvasElement[] }) | null)?.elements ?? [];
        if (!cancelled) setElements(targetElements);
      })
      .catch(() => { if (!cancelled) setElements([]); });
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

export const LinkElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const config = useMemo(() => parseLinkConfig(element.config), [element.config]);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setActiveCanvas = useConductorStore((state) => state.setActiveCanvas);
  const setActiveThread = useConversationStore((state) => state.setActiveThread);
  const title = titleFor(config);
  const meta = metaFor(config);

  const open = useCallback(() => {
    if (config.linkType === "url" && config.url) window.open(config.url, "_blank", "noopener,noreferrer");
    if (config.linkType === "canvas" && config.targetId) setActiveCanvas(config.targetId);
    if (config.linkType === "session" && config.targetId) setActiveThread(config.targetId);
  }, [config, setActiveCanvas, setActiveThread]);
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
  const toggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!activeCanvasId) return;
    const expanded = !config.expanded;
    const size = expanded ? config.expandedSize ?? (config.linkType === "url" ? { w: 5, h: 2 } : { w: 5, h: 4 }) : { w: 4, h: 1 };
    void executeAction({ action: "element.update", elementId: element.id, canvasId: activeCanvasId, position: { ...element.position, ...size }, config: { ...element.config, expanded } });
  }, [activeCanvasId, config.expanded, config.expandedSize, config.linkType, element.config, element.id, element.position]);

  useEffect(() => {
    if (!config.expanded || !activeCanvasId || (element.position.w === config.expandedSize?.w && element.position.h === config.expandedSize?.h)) return;
    void executeAction({ action: "element.update", elementId: element.id, canvasId: activeCanvasId, config: { ...element.config, expandedSize: { w: element.position.w, h: element.position.h } } });
  }, [activeCanvasId, config.expanded, config.expandedSize?.h, config.expandedSize?.w, element.config, element.id, element.position.h, element.position.w]);

  if (!config.expanded) return <div className="canvas-link canvas-link--compact" role="link" tabIndex={0} onKeyDown={onKeyDown} onClick={(event) => { event.stopPropagation(); open(); }}>
    <LinkMark type={config.linkType} faviconUrl={config.faviconUrl} /><span className="canvas-link__compact-title">{title}</span><span className="canvas-link__compact-meta">{meta}</span>
    <button type="button" aria-label="Expand link card" onClick={toggle}>⌄</button>
  </div>;

  const isInternal = config.linkType !== "url";
  return <article className={`canvas-link canvas-link--expanded canvas-link--${config.linkType}`} role="link" tabIndex={0} onKeyDown={onKeyDown} onClick={(event) => { event.stopPropagation(); open(); }}>
    {config.linkType === "canvas" && <CanvasLinkPreview canvasId={config.targetId} title={title} />}
    {isInternal && config.linkType === "session" && <div className="canvas-link__preview canvas-link__preview--session" aria-hidden="true"><span className="canvas-link__preview-empty">Conversation</span></div>}
    <header><LinkMark type={config.linkType} faviconUrl={config.faviconUrl} /><div><span className="canvas-link__eyebrow">{LINK_LABEL[config.linkType]}</span><h3>{title}</h3><p>{meta}</p></div><button type="button" aria-label="Collapse link card" onClick={toggle}>⌃</button></header>
    {config.description && config.linkType === "url" && <p className="canvas-link__description">{config.description}</p>}
    <footer><button type="button" onClick={copy}>Copy link</button><span>↗ Open</span></footer>
  </article>;
};

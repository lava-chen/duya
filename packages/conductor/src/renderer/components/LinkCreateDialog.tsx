"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkContent } from "../types/canvas-node";
import { useConversationStore } from "@/stores/conversation-store";
import { listCanvases } from "../ipc/conductor-ipc";

type LinkType = LinkContent["linkType"];

interface LinkCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (content: LinkContent) => void;
}

interface CanvasMeta { id: string; name: string; }
interface SearchItem { id: string; type: LinkType; title: string; subtitle: string; }

function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  return value.startsWith("http://") || value.startsWith("https://") || /^[^\s]+\.[^\s]{2,}$/.test(value);
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

function domainFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function LinkGlyph({ type }: { type: LinkType }) {
  const label = type === "url" ? "↗" : type === "canvas" ? "⌘" : "◌";
  return <span className={`canvas-link-picker__glyph canvas-link-picker__glyph--${type}`}>{label}</span>;
}

const DUYA_LINK_RE = /^duya:\/\/(session|canvas)\/(.+)$/;

function parseDuyaLink(input: string): { linkType: "session" | "canvas"; targetId: string } | null {
  const match = input.trim().match(DUYA_LINK_RE);
  return match && (match[1] === "session" || match[1] === "canvas")
    ? { linkType: match[1], targetId: match[2] }
    : null;
}

export const LinkCreateDialog: React.FC<LinkCreateDialogProps> = ({ open, onClose, onConfirm }) => {
  const [query, setQuery] = useState("");
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const threads = useConversationStore((state) => state.threads);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [canvasBounds, setCanvasBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 50);
    listCanvases().then((list) => setCanvases(list.map((canvas) => ({ id: canvas.id, name: canvas.name })))).catch(() => setCanvases([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateBounds = () => setCanvasBounds(document.querySelector(".canvas-area")?.getBoundingClientRect() ?? null);
    updateBounds();
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [open]);

  const items = useMemo<SearchItem[]>(() => {
    const term = query.trim().toLowerCase();
    const result: SearchItem[] = [];
    if (query.trim() && looksLikeUrl(query)) {
      const url = normalizeUrl(query);
      result.push({ id: "__url__", type: "url", title: domainFromUrl(url), subtitle: url });
    }
    result.push(...canvases.filter((canvas) => !term || canvas.name.toLowerCase().includes(term)).map((canvas) => ({ id: canvas.id, type: "canvas" as const, title: canvas.name, subtitle: "Canvas" })));
    result.push(...threads.filter((thread) => !term || (thread.title || "").toLowerCase().includes(term)).map((thread) => ({ id: thread.id, type: "session" as const, title: thread.title || "Untitled session", subtitle: "Conversation" })));
    return result;
  }, [canvases, query, threads]);

  useEffect(() => setSelectedIndex((index) => Math.min(index, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: "nearest" }); }, [selectedIndex]);

  const selectItem = useCallback((item: SearchItem) => {
    const duya = parseDuyaLink(query);
    const content: LinkContent = duya
      ? { linkType: duya.linkType, targetId: duya.targetId, title: item.title, expanded: true }
      : item.type === "url"
        ? { linkType: "url", url: item.subtitle, title: item.title, siteName: domainFromUrl(item.subtitle), expanded: false }
        : { linkType: item.type, targetId: item.id, title: item.title, description: item.subtitle, expanded: true };
    onConfirm(content);
    onClose();
  }, [onClose, onConfirm, query]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "ArrowDown") { event.preventDefault(); setSelectedIndex((index) => Math.min(index + 1, items.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelectedIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === "Enter" && items[selectedIndex]) { event.preventDefault(); selectItem(items[selectedIndex]); }
  }, [items, onClose, selectItem, selectedIndex]);

  if (!open) return null;
  const groups: Array<{ title: string; type: LinkType; items: SearchItem[] }> = [
    { title: "Paste a link", type: "url", items: items.filter((item) => item.type === "url") },
    { title: "Canvases", type: "canvas", items: items.filter((item) => item.type === "canvas") },
    { title: "Conversations", type: "session", items: items.filter((item) => item.type === "session") },
  ];

  let globalIndex = 0;
  const dialog = <div className="canvas-link-picker-overlay" style={canvasBounds ? { inset: "auto", left: canvasBounds.left, top: canvasBounds.top, width: canvasBounds.width, height: canvasBounds.height } : undefined} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="canvas-link-picker" role="dialog" aria-modal="true" aria-label="Create a canvas link" onMouseDown={(event) => event.stopPropagation()}>
      <div className="canvas-link-picker__input-row">
        <span className="canvas-link-picker__search">⌕</span>
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search canvases or paste a URL…" />
        <button type="button" onClick={onClose} aria-label="Close link picker">×</button>
      </div>
      <div className="canvas-link-picker__results" ref={listRef}>
        {items.length === 0 ? <p className="canvas-link-picker__empty">No matching canvas or conversation.</p> : groups.map((group) => {
          if (!group.items.length) return null;
          return <section className="canvas-link-picker__group" key={group.type}><h2>{group.title}</h2>{group.items.map((item) => {
            const index = globalIndex++;
            const selected = index === selectedIndex;
            return <button key={`${item.type}-${item.id}`} type="button" data-index={index} className={`canvas-link-picker__item${selected ? " is-selected" : ""}`} onMouseEnter={() => setSelectedIndex(index)} onClick={() => selectItem(item)}>
              <LinkGlyph type={item.type} /><span><strong>{item.title}</strong><small>{item.subtitle}</small></span>{selected && <kbd>↵</kbd>}
            </button>;
          })}</section>;
        })}
      </div>
      <footer><span>↑↓ Navigate</span><span>↵ Insert</span><span>Esc Close</span></footer>
    </div>
  </div>;
  return createPortal(dialog, document.body);
};

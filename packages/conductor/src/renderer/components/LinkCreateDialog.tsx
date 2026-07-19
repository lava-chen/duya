"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkContent } from "../types/canvas-node";
import type { TranslationKey } from "@/i18n";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
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
  const { t } = useTranslation();
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
    result.push(...canvases.filter((canvas) => !term || canvas.name.toLowerCase().includes(term)).map((canvas) => ({ id: canvas.id, type: "canvas" as const, title: canvas.name, subtitle: t("conductor.link.canvas") })));
    result.push(...threads.filter((thread) => !term || (thread.title || "").toLowerCase().includes(term)).map((thread) => ({ id: thread.id, type: "session" as const, title: thread.title || t("conductor.link.untitledSession"), subtitle: t("conductor.link.conversation") })));
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
  const groups: Array<{ title: TranslationKey; type: LinkType; items: SearchItem[] }> = [
    { title: "conductor.link.pasteLink", type: "url", items: items.filter((item) => item.type === "url") },
    { title: "conductor.link.canvases", type: "canvas", items: items.filter((item) => item.type === "canvas") },
    { title: "conductor.link.conversations", type: "session", items: items.filter((item) => item.type === "session") },
  ];

  let globalIndex = 0;
  const dialog = <div className="canvas-link-picker-overlay" style={canvasBounds ? { inset: "auto", left: canvasBounds.left, top: canvasBounds.top, width: canvasBounds.width, height: canvasBounds.height } : undefined} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="canvas-link-picker" role="dialog" aria-modal="true" aria-label={t("conductor.link.title")} onMouseDown={(event) => event.stopPropagation()}>
      <div className="canvas-link-picker__input-row">
        <span className="canvas-link-picker__search">⌕</span>
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder={t("conductor.link.placeholder")} />
        <button type="button" onClick={onClose} aria-label={t("conductor.link.close")}>×</button>
      </div>
      <div className="canvas-link-picker__results" ref={listRef}>
        {items.length === 0 ? <p className="canvas-link-picker__empty">{t("conductor.link.empty")}</p> : groups.map((group) => {
          if (!group.items.length) return null;
          return <section className="canvas-link-picker__group" key={group.type}><h2>{t(group.title)}</h2>{group.items.map((item) => {
            const index = globalIndex++;
            const selected = index === selectedIndex;
            return <button key={`${item.type}-${item.id}`} type="button" data-index={index} className={`canvas-link-picker__item${selected ? " is-selected" : ""}`} onMouseEnter={() => setSelectedIndex(index)} onClick={() => selectItem(item)}>
              <LinkGlyph type={item.type} /><span><strong>{item.title}</strong><small>{item.subtitle}</small></span>{selected && <kbd>↵</kbd>}
            </button>;
          })}</section>;
        })}
      </div>
      <footer><span>{t("conductor.link.navigate")}</span><span>{t("conductor.link.insert")}</span><span>{t("conductor.link.closeKey")}</span></footer>
    </div>
  </div>;
  return createPortal(dialog, document.body);
};

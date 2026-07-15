"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkContent } from "..//types/canvas-node";
import { useConversationStore } from "@/stores/conversation-store";
import { listCanvases } from "..//ipc/conductor-ipc";

type LinkType = LinkContent["linkType"];

interface LinkCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (content: LinkContent) => void;
}

interface CanvasMeta {
  id: string;
  name: string;
}

interface SearchItem {
  id: string;
  type: LinkType;
  title: string;
  subtitle: string;
  icon: string;
}

function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  // Loose URL heuristic: contains a dot and no spaces, e.g. example.com
  if (/^[^\s]+\.[^\s]{2,}$/.test(trimmed)) return true;
  return false;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

const DUYA_LINK_RE = /^duya:\/\/(session|canvas)\/(.+)$/;

function parseDuyaLink(input: string): { linkType: "session" | "canvas"; targetId: string } | null {
  const match = input.trim().match(DUYA_LINK_RE);
  if (!match) return null;
  const linkType = match[1];
  if (linkType !== "session" && linkType !== "canvas") return null;
  return { linkType, targetId: match[2] };
}

export const LinkCreateDialog: React.FC<LinkCreateDialogProps> = ({
  open,
  onClose,
  onConfirm,
}) => {
  const [query, setQuery] = useState("");
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const threads = useConversationStore((state) => state.threads);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 50);
      listCanvases()
        .then((list) => setCanvases(list.map((c) => ({ id: c.id, name: c.name }))))
        .catch(() => setCanvases([]));
    }
  }, [open]);

  const items = useMemo<SearchItem[]>(() => {
    const trimmed = query.trim();
    const result: SearchItem[] = [];

    // External URL option when the query looks like a URL.
    if (trimmed && looksLikeUrl(trimmed)) {
      const url = normalizeUrl(trimmed);
      result.push({
        id: "__url__",
        type: "url",
        title: trimmed,
        subtitle: url,
        icon: "🌐",
      });
    }

    const lowerQuery = trimmed.toLowerCase();

    // Canvas items.
    const canvasItems: SearchItem[] = canvases
      .filter((c) => !lowerQuery || c.name.toLowerCase().includes(lowerQuery))
      .map((c) => ({
        id: c.id,
        type: "canvas",
        title: c.name,
        subtitle: "DUYA Canvas",
        icon: "🎨",
      }));

    // Session items.
    const sessionItems: SearchItem[] = threads
      .filter((t) => !lowerQuery || (t.title || "").toLowerCase().includes(lowerQuery))
      .map((t) => ({
        id: t.id,
        type: "session",
        title: t.title || "Untitled Session",
        subtitle: "DUYA Session",
        icon: "💬",
      }));

    return [...result, ...canvasItems, ...sessionItems];
  }, [query, canvases, threads]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, items.length - 1)));
  }, [items.length]);

  const handleSelect = useCallback(
    (item: SearchItem) => {
      const trimmed = query.trim();
      const duya = trimmed ? parseDuyaLink(trimmed) : null;

      let content: LinkContent;
      if (duya) {
        content = {
          linkType: duya.linkType,
          targetId: duya.targetId,
          title: item.title,
          expanded: false,
        };
      } else if (item.type === "url") {
        content = {
          linkType: "url",
          url: item.subtitle,
          title: item.title === item.subtitle ? undefined : item.title,
          expanded: false,
        };
      } else {
        content = {
          linkType: item.type,
          targetId: item.id,
          title: item.title,
          expanded: false,
        };
      }

      onConfirm(content);
      onClose();
    },
    [onConfirm, onClose, query]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) handleSelect(item);
        return;
      }
    },
    [items, onClose, selectedIndex, handleSelect]
  );

  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div
      className="conductor-confirmation-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="conductor-confirmation-dialog"
        style={{
          width: "min(90vw, 520px)",
          padding: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "min(80vh, 560px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid var(--conductor-border)",
          }}
        >
          <span style={{ fontSize: 16, color: "var(--text-tertiary)" }}>🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search canvases / sessions or paste a URL..."
            style={{
              flex: 1,
              fontSize: 15,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              border: "none",
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          ref={listRef}
          style={{
            flex: 1,
            overflow: "auto",
            padding: "8px 0",
          }}
        >
          {items.length === 0 && (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: 13,
              }}
            >
              {query.trim() ? "No canvases, sessions, or URLs matched." : "Start typing to search."}
            </div>
          )}

          {items.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                key={`${item.type}-${item.id}`}
                type="button"
                data-index={index}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 16px",
                  textAlign: "left",
                  border: "none",
                  background: isSelected ? "var(--conductor-accent-soft)" : "transparent",
                  cursor: "pointer",
                  transition: "background 0.12s ease",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    flexShrink: 0,
                    background: "var(--surface)",
                    border: "1px solid var(--conductor-border)",
                  }}
                >
                  {item.icon}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-tertiary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.subtitle}
                  </div>
                </div>
                {isSelected && (
                  <span style={{ fontSize: 12, color: "var(--conductor-accent)" }}>↵</span>
                )}
              </button>
            );
          })}
        </div>

        <div
          style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--conductor-border)",
            fontSize: 12,
            color: "var(--text-tertiary)",
            display: "flex",
            gap: 12,
          }}
        >
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
};

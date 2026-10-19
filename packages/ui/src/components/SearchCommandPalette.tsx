"use client";

/**
 * SearchCommandPalette — Cmd/Ctrl+K unified command palette.
 *
 * Two modes in one panel:
 *  - Browse (empty query): lists static command entries grouped under muted
 *    section headers (快捷操作 / 设置 / Skills / 插件 …), scrollable.
 *  - Search (typing, debounced 200ms): queries `db:search:query` and groups
 *    hits by kind (聊天 / Bot / 消息 / 链接 / 例行).
 *
 * UI follows a minimalist command-palette look: seamless rounded panel,
 * borderless full-width input ("搜索聊天"), rows with a shortcut pill
 * (⌘/Ctrl+<n>). ↑/↓, Enter, ⌘/Ctrl+1..9 navigate/select; Esc or overlay click
 * dismisses. Session/message/link hits jump into the thread, bot hits open the
 * bot chat, command entries navigate to their view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversationStore, type ViewType } from "@/stores/conversation-store";
import { useSearchPaletteStore } from "@/stores/search-palette-store";
import { resolveBotOpenThreadId } from "@/lib/bot-thread-jump";
import {
  SEARCH_KIND_LABEL,
  searchUnified,
  type UnifiedSearchHit,
  type UnifiedSearchKind,
} from "@/lib/search-ipc";

const KIND_ORDER: UnifiedSearchKind[] = ["session", "bot", "message", "link", "routine"];

/** A static command entry (runs an action, not a search hit). */
interface CommandItem {
  key: string;
  title: string;
  snippet?: string;
  run: () => void;
}

type PaletteItem = CommandItem | UnifiedSearchHit;

interface PaletteSection {
  label: string;
  items: PaletteItem[];
  start: number;
}

const isCommand = (item: PaletteItem): item is CommandItem => "run" in item;

export function SearchCommandPalette() {
  const open = useSearchPaletteStore((s) => s.open);
  const setOpen = useSearchPaletteStore((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UnifiedSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ─── Actions ───
  const goView = useCallback(
    (view: ViewType) => {
      useConversationStore.getState().setCurrentView(view);
      setOpen(false);
    },
    [setOpen],
  );

  // Static command sections shown when the query is empty (browse mode).
  const commandSections = useMemo<PaletteSection[]>(() => {
    const groups: Array<[string, CommandItem[]]> = [
      [
        "快捷操作",
        [
          { key: "cmd:newchats", title: "新聊天", run: () => useConversationStore.getState().startNewChat() },
          { key: "cmd:home", title: "主页", run: () => goView("home") },
        ],
      ],
      [
        "设置",
        [
          { key: "cmd:settings", title: "设置", run: () => goView("settings") },
          { key: "cmd:skills", title: "Skills", run: () => goView("skills") },
          { key: "cmd:plugins", title: "插件", run: () => goView("extensions") },
          { key: "cmd:automation", title: "自动化", run: () => goView("automation") },
          { key: "cmd:agents", title: "Agents", run: () => goView("agents") },
          { key: "cmd:conductor", title: "画布", run: () => goView("conductor") },
        ],
      ],
    ];
    let start = 0;
    const sections: PaletteSection[] = [];
    for (const [label, items] of groups) {
      sections.push({ label, items, start });
      start += items.length;
    }
    return sections;
  }, [goView]);

  // Global open/close shortcut.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useSearchPaletteStore.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape dismisses; reset + autofocus on open.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setLoading(false);
      return;
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onEsc);
      window.clearTimeout(id);
    };
  }, [open, setOpen]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = window.setTimeout(() => {
      void searchUnified(q).then((results) => {
        setHits(results);
        setSelected(0);
        setLoading(false);
      });
    }, 200);
    return () => window.clearTimeout(id);
  }, [query, open]);

  const selectItem = useCallback(
    (item: PaletteItem) => {
      setOpen(false);
      if (isCommand(item)) {
        item.run();
        return;
      }
      const hit = item;
      if (hit.sessionId) {
        useConversationStore.getState().setActiveThread(hit.sessionId);
        useConversationStore.getState().setCurrentView("chat");
      } else if (hit.botId) {
        useConversationStore.getState().setActiveThread(resolveBotOpenThreadId(hit.botId));
        useConversationStore.getState().setCurrentView("chat");
      }
      // routine hits (no session/bot mapping) are display-only for now.
    },
    [setOpen],
  );

  // Search-hit groups (kind-ordered, with global start offsets).
  const searchSections = useMemo<PaletteSection[]>(() => {
    let start = 0;
    const sections: PaletteSection[] = [];
    for (const kind of KIND_ORDER) {
      const items = hits.filter((h) => h.kind === kind);
      if (items.length === 0) continue;
      sections.push({ label: SEARCH_KIND_LABEL[kind], items, start });
      start += items.length;
    }
    return sections;
  }, [hits]);

  const browsing = !query.trim();
  // In search mode, merge command entries filtered by the query (so "设置",
  // "Skills", "插件" … are themselves searchable) with the backend hits.
  const sections = useMemo<PaletteSection[]>(() => {
    if (browsing) return commandSections;
    const groups: PaletteSection[] = [];
    let start = 0;
    const push = (label: string, items: PaletteItem[]) => {
      if (items.length === 0) return;
      groups.push({ label, items, start });
      start += items.length;
    };
    const q = query.trim().toLowerCase();
    if (q) {
      for (const section of commandSections) {
        push(
          section.label,
          section.items.filter((it) =>
            [it.title, it.snippet ?? ""].join(" ").toLowerCase().includes(q),
          ),
        );
      }
    }
    for (const section of searchSections) push(section.label, section.items);
    return groups;
  }, [browsing, commandSections, searchSections, query]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter") {
        const item = flat[selected];
        if (item) selectItem(item);
      } else if (event.key >= "1" && event.key <= "9") {
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          const item = flat[Number(event.key) - 1];
          if (item) selectItem(item);
        }
      }
    },
    [flat, selected, selectItem],
  );

  if (!open) return null;

  return (
    <div className="search-palette-overlay" onMouseDown={() => setOpen(false)}>
      <div
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-palette-input-wrap">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索聊天"
            aria-label="搜索聊天"
            className="search-palette-input"
          />
          <span className="search-palette-hint">⌘K</span>
        </div>

        <div className="search-palette-results">
          {loading ? (
            <div className="search-palette-empty">搜索中…</div>
          ) : browsing ? (
            sections.map((section) => (
              <div key={section.label} className="search-palette-group">
                <div className="search-palette-group-label">{section.label}</div>
                {section.items.map((item, offset) => {
                  const index = section.start + offset;
                  return (
                    <Row
                      key={item.key}
                      item={item}
                      index={index}
                      selected={selected}
                      onSelect={selectItem}
                      onHover={setSelected}
                    />
                  );
                })}
              </div>
            ))
          ) : flat.length === 0 ? (
            <div className="search-palette-empty">无结果</div>
          ) : (
            sections.map((section) => (
              <div key={section.label} className="search-palette-group">
                <div className="search-palette-group-label">{section.label}</div>
                {section.items.map((item, offset) => {
                  const index = section.start + offset;
                  return (
                    <Row
                      key={item.key}
                      item={item}
                      index={index}
                      selected={selected}
                      onSelect={selectItem}
                      onHover={setSelected}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  item,
  index,
  selected,
  onSelect,
  onHover,
}: {
  item: PaletteItem;
  index: number;
  selected: number;
  onSelect: (item: PaletteItem) => void;
  onHover: (index: number) => void;
}) {
  const isCommandRow = isCommand(item);
  return (
    <button
      type="button"
      className={"search-palette-row" + (index === selected ? " is-active" : "")}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHover(index)}
    >
      <div className="search-palette-row-title">
        <span className="search-palette-title-text" dir="auto">
          {item.title}
        </span>
        {index < 9 ? (
          <span className="search-palette-kbd">
            {(typeof navigator !== "undefined" &&
            navigator.platform?.toLowerCase().includes("mac")
              ? "⌘"
              : "Ctrl") +
              (index + 1)}
          </span>
        ) : null}
      </div>
      {!isCommandRow && item.snippet ? (
        <div className="search-palette-snippet" dir="auto">
          {item.snippet}
        </div>
      ) : null}
    </button>
  );
}
"use client";

/**
 * BotAvatarPicker — combined emoji + background-color selector for a bot's
 * character tile (Plan 483 P2.1c identity view, Notion page-icon style).
 *
 * One control replaces the old separate "emoji textbox" and "color circle
 * row". Clicking the preview tile opens a floating popover containing a
 * searchable, category-browsable emoji grid plus the background color
 * palette — both edit options live together in a single picker.
 *
 * `emoji === ""` means "no explicit emoji" → the character falls back to the
 * deterministic per-agent emoji, so the picker's remove action just clears
 * the explicit value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/Input";
import { usePopoverPlacement } from "@/components/ui/usePopoverPlacement";
import { MagnifyingGlassIcon, PencilIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BOT_EMOJI_CATEGORIES, filterBotEmojis } from "@/lib/bot-emoji";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";

export interface BotAvatarPickerProps {
  /** Displayed name — only used to fall back inside the preview tile. */
  name: string;
  agentId: string;
  /** Explicit emoji value ('' = auto-assigned by the character). */
  emoji: string;
  onEmojiChange: (emoji: string) => void;
  /** Background color token id. */
  color: string;
  onColorChange: (color: string) => void;
}

/** Popover surface width (matches the Notion page-icon picker footprint). */
const POPOVER_WIDTH = 300;

export function BotAvatarPicker({
  name,
  agentId,
  emoji,
  onEmojiChange,
  color,
  onColorChange,
}: BotAvatarPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(BOT_EMOJI_CATEGORIES[0].id);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const categoryRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const { ref, popoverRef, style } = usePopoverPlacement<HTMLDivElement>({
    placement: "bottom-start",
    offsetPx: 6,
  });

  // Close the picker on any pointer-down outside of the anchor+popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const results = useMemo(
    () => (query.trim() ? filterBotEmojis(query) : null),
    [query],
  );

  const scrollToCategory = useCallback((id: string) => {
    setActiveCategory(id);
    setQuery("");
    categoryRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      ref={(node) => {
        wrapperRef.current = node;
        ref(node);
      }}
      className="relative w-fit"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("bot.avatarPicker.label")}
        title={t("bot.avatarPicker.label")}
        className="group relative block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <BotCharacterAvatar
          name={name || "?"}
          agentId={agentId}
          avatarColor={color}
          avatarEmoji={emoji}
          size={44}
        />
        {/* Hover edit scrim — dims the tile and reveals a pencil on hover. */}
        <span
          className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}
          aria-hidden="true"
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-black/80">
            <PencilIcon size={13} />
          </span>
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="flex flex-col"
          style={{
            ...style,
            zIndex: 70,
            width: POPOVER_WIDTH,
            background: "var(--surface-solid, var(--main-bg))",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 10px 32px rgba(0,0,0,0.25)",
            padding: "8px 10px",
          }}
          role="dialog"
          aria-label={t("bot.avatarPicker.label")}
        >
          {/* Search + remove header */}
          <div className="mb-2 flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                size="sm"
                prefix={<MagnifyingGlassIcon size={14} />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("bot.avatarPicker.searchPlaceholder")}
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => {
                onEmojiChange("");
                close();
              }}
              className="shrink-0 rounded-lg px-2 py-1.5 text-xs transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}
              title={t("bot.avatarPicker.remove")}
            >
              {t("bot.avatarPicker.remove")}
            </button>
          </div>

          {/* Scrollable emoji area */}
          <div className="overflow-y-auto pr-1" style={{ maxHeight: 240 }}>
            {results ? (
              results.length ? (
                <div className="grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
                  {results.map((e) => (
                    <EmojiCell
                      key={`${e.categoryId}-${e.char}`}
                      char={e.char}
                      onPick={() => onEmojiChange(e.char)}
                    />
                  ))}
                </div>
              ) : (
                <div
                  className="py-6 text-center text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("bot.avatarPicker.empty")}
                </div>
              )
            ) : (
              <div className="flex flex-col gap-1">
                {BOT_EMOJI_CATEGORIES.map((cat) => (
                  <div key={cat.id}>
                    <div
                      ref={(n) => {
                        if (n) categoryRefs.current.set(cat.id, n);
                        else categoryRefs.current.delete(cat.id);
                      }}
                      className="px-0.5 pb-0.5 pt-1.5 text-[11px] font-medium"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t(cat.labelKey)}
                    </div>
                    <div className="grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
                      {cat.emojis.map((e) => (
                        <EmojiCell key={e.char} char={e.char} onPick={() => onEmojiChange(e.char)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Category rail */}
          {!results && (
            <div
              className="mt-2 flex items-center justify-between border-t pt-2"
              style={{ borderColor: "var(--border)" }}
            >
              {BOT_EMOJI_CATEGORIES.map((cat) => {
                const active = cat.id === activeCategory;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => scrollToCategory(cat.id)}
                    aria-label={t(cat.labelKey)}
                    title={t(cat.labelKey)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-sm transition-colors"
                    style={{
                      background: active ? "var(--surface-hover)" : "transparent",
                    }}
                  >
                    {cat.nav}
                  </button>
                );
              })}
            </div>
          )}

          {/* Background color palette */}
          <div
            className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="mr-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {t("bot.avatarPicker.color")}
            </span>
            {BOT_AVATAR_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onColorChange(c.id)}
                aria-label={c.label}
                title={c.label}
                className="rounded-full transition-transform hover:scale-110"
                style={{
                  width: 16,
                  height: 16,
                  backgroundColor: c.value,
                  outline: color === c.id ? "2px solid var(--text)" : "none",
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmojiCell({ char, onPick }: { char: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex h-8 items-center justify-center rounded-lg text-xl leading-none transition-colors hover:bg-[var(--surface-hover)]"
      style={{ background: "transparent" }}
    >
      {char}
    </button>
  );
}
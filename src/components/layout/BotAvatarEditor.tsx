"use client";

/**
 * BotAvatarEditor — the bot identity avatar block (Plan 528 restyle).
 *
 * One centered, tappable avatar tile on top. Clicking it opens a small menu
 * with two actions: upload an image, or pick an emoji (which expands a simple
 * category grid below). A compact preset-color swatch row sits underneath,
 * hidden as soon as the bot has an explicit uploaded image (color only applies
 * to the fallback character tile). Shared by the edit dialog and the settings
 * side panel so the two surfaces stay visually identical.
 */

import { useState } from "react";
import { PencilIcon } from "@/components/icons";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useTranslation } from "@/hooks/useTranslation";
import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BOT_EMOJI_CATEGORIES } from "@/lib/bot-emoji";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";

export interface BotAvatarEditorProps {
  /** Displayed name — fallback inside the preview tile. */
  name: string;
  agentId: string;
  /** Explicit emoji value ('' = auto-assigned by the character). */
  emoji: string;
  onEmojiChange: (emoji: string) => void;
  /** Background color token id. */
  color: string;
  onColorChange: (color: string) => void;
  avatarUrl?: string | null;
  avatarBusy?: boolean;
  /** Invoked when the user picks "upload image" from the menu. */
  onUpload: () => void;
}

export function BotAvatarEditor({
  name,
  agentId,
  emoji,
  onEmojiChange,
  color,
  onColorChange,
  avatarUrl,
  avatarBusy,
  onUpload,
}: BotAvatarEditorProps) {
  const { t } = useTranslation();
  const [emojiOpen, setEmojiOpen] = useState(false);

  const hasImage = !!avatarUrl;

  const menuItems: MenuAction[] = [
    {
      kind: "action",
      id: "upload",
      label: t("bot.avatar.upload"),
      disabled: avatarBusy,
      onSelect: onUpload,
    },
    {
      kind: "action",
      id: "pickEmoji",
      label: t("bot.avatar.pickEmoji"),
      onSelect: () => setEmojiOpen(true),
    },
  ];

  return (
    <div
      className="relative flex flex-col items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <DropdownMenu
        trigger={
          <button
            type="button"
            aria-label={t("bot.avatarPicker.label")}
            className="group relative block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <BotCharacterAvatar
              name={name || "?"}
              agentId={agentId}
              avatarUrl={avatarUrl ?? undefined}
              avatarColor={color}
              avatarEmoji={emoji}
              size={64}
            />
            <span
              className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              style={{ background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}
              aria-hidden="true"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-black/80">
                <PencilIcon size={15} />
              </span>
            </span>
          </button>
        }
        items={menuItems}
      />

      {emojiOpen && !hasImage && (
        <div
          className="mt-2 w-full max-w-[300px] rounded-xl border p-2"
          style={{
            background: "var(--surface-solid, var(--main-bg))",
            borderColor: "var(--border)",
            maxHeight: 220,
            overflowY: "auto",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {BOT_EMOJI_CATEGORIES.map((cat) => (
            <div key={cat.id}>
              <div
                className="px-0.5 pb-0.5 pt-1.5 text-[11px] font-medium"
                style={{ color: "var(--text-muted)" }}
              >
                {t(cat.labelKey)}
              </div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
                {cat.emojis.map((e) => (
                  <button
                    key={e.char}
                    type="button"
                    onClick={() => {
                      onEmojiChange(e.char);
                      setEmojiOpen(false);
                    }}
                    className="flex h-8 items-center justify-center rounded-lg text-xl leading-none transition-colors hover:bg-[var(--surface-hover)]"
                    style={{ background: "transparent" }}
                  >
                    {e.char}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!hasImage && (
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {BOT_AVATAR_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onColorChange(c.id)}
              aria-label={c.label}
              title={c.label}
              className="shrink-0 rounded-full transition-transform hover:scale-110"
              style={{
                width: 18,
                height: 18,
                backgroundColor: c.value,
                outline: color === c.id ? "2px solid var(--text)" : "2px solid transparent",
                outlineOffset: 1,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
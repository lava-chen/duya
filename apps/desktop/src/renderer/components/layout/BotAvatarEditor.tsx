"use client";

/**
 * BotAvatarEditor — the bot identity avatar block.
 *
 * A centered preview of the animated agent face plus a preset-color swatch
 * row underneath: the body color is the only editable aspect of the avatar
 * (the face itself is fixed). Shared by the edit dialog and the settings
 * side panel so the two surfaces stay visually identical.
 */

import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";

export interface BotAvatarEditorProps {
  /** Displayed name — identity of the preview tile. */
  name: string;
  agentId: string;
  /** Face body color token id. */
  color: string;
  onColorChange: (color: string) => void;
}

export function BotAvatarEditor({
  name,
  agentId,
  color,
  onColorChange,
}: BotAvatarEditorProps) {
  return (
    <div
      className="flex flex-col items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <BotCharacterAvatar
        name={name || "?"}
        agentId={agentId}
        avatarColor={color}
        size={64}
      />

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
    </div>
  );
}

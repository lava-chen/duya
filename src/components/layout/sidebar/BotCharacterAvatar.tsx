"use client";

/**
 * BotCharacterAvatar — bot avatar renderer.
 *
 * Priority:
 *   1. `avatarUrl` — an uploaded / agent-generated image file served over
 *      the `duya-file://` protocol (URL prebuilt by the main process,
 *      `?v=<mtime>` cache-busted).
 *   2. Otherwise a colored circle with a deterministic emoji — each agent
 *      id maps to a stable emoji from a bot-themed palette, on the color
 *      token (or deterministic-hue) background.
 */

import { botAvatarColorHex } from "@/lib/bot-avatar";
import { deriveBotContactHue } from "./bot-contacts";

export interface BotCharacterAvatarProps {
  name: string;
  agentId: string;
  /** `duya-file://` URL of the bot's avatar image (main-process built). */
  avatarUrl?: string;
  /** Color token id for the emoji tile background (used when no image). */
  avatarColor?: string;
  /** User-picked emoji for the colored circle (wins over the deterministic one). */
  avatarEmoji?: string;
  size?: number;
  /** Kept for call-site compatibility (streaming indicator is row-level). */
  working?: boolean;
}

/** Bot-themed emoji palette — seeded by the agent id so each bot keeps a
    stable face without an extra config field. */
const BOT_EMOJI_PALETTE = [
  "🤖", "🦾", "👾", "🧠", "💡", "✨", "🚀", "🔮",
  "📊", "🎯", "📝", "🛠️", "🧩", "🗂️", "📈", "🎨",
  "🔬", "🤝", "🧭", "⚙️", "🦉", "🐙", "🌐", "🔥",
];

export function BotCharacterAvatar({
  agentId,
  avatarUrl,
  avatarColor,
  avatarEmoji,
  size = 38,
}: BotCharacterAvatarProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="bot-character-avatar"
        style={{ width: size, height: size }}
      />
    );
  }

  // Emoji tile: explicit token color, else the deterministic per-agent
  // hue converted to hex (legacy config agents / unset color).
  const backgroundColor = botContactColorHex(agentId, avatarColor) ?? "#777777";
  return (
    <span
      className="bot-contact-avatar"
      style={{
        backgroundColor,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.63),
      }}
      aria-hidden="true"
    >
      {avatarEmoji?.trim() || botEmojiFor(agentId)}
    </span>
  );
}

/**
 * Hex for an agent's identity color — explicit token first, else the
 * deterministic hue derived from the agent id. Shared so that names in a
 * transcript chip can be colored to match the avatar tile.
 */
export function botContactColorHex(
  agentId: string,
  avatarColor?: string,
): string | null {
  const tokenHex = botAvatarColorHex(avatarColor);
  return tokenHex ?? hslToHex(deriveBotContactHue(agentId), 42, 46);
}

/** Stable emoji for an agent id (hash into the bot-themed palette). */
function botEmojiFor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash << 5) - hash + agentId.charCodeAt(i);
    hash |= 0;
  }
  return BOT_EMOJI_PALETTE[Math.abs(hash) % BOT_EMOJI_PALETTE.length];
}

/** hsl(h, s%, l%) → #rrggbb (matches the legacy `hsl(hue 42% 46%)` fallback). */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) =>
    ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

"use client";

/**
 * BotCharacterAvatar — bot avatar renderer (Plan 483 P1.2, revised
 * 2026-09-05: geometric shape tokens removed).
 *
 * Priority:
 *   1. `avatarUrl` — an uploaded / agent-generated image file served over
 *      the `duya-file://` protocol (URL prebuilt by the main process,
 *      `?v=<mtime>` cache-busted).
 *   2. `avatarColor` — colored initial circle from a color token.
 *   3. Fallback — deterministic-hue initial circle (legacy config agents).
 */

import React from "react";
import { botAvatarColorHex } from "@/lib/bot-avatar";
import { deriveBotAvatarLabel, deriveBotContactHue } from "./bot-contacts";

export interface BotCharacterAvatarProps {
  name: string;
  agentId: string;
  /** `duya-file://` URL of the bot's avatar image (main-process built). */
  avatarUrl?: string;
  /** Color token id for the initial-circle avatar (used when no image). */
  avatarColor?: string;
  size?: number;
}

export function BotCharacterAvatar({
  name,
  agentId,
  avatarUrl,
  avatarColor,
  size = 26,
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
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }

  // Colored initial circle: explicit token color, else the deterministic
  // per-agent hue (legacy config agents / unset color).
  const tokenHex = botAvatarColorHex(avatarColor);
  const hue = deriveBotContactHue(agentId);
  return (
    <span
      className="bot-contact-avatar"
      style={{
        backgroundColor: tokenHex ?? `hsl(${hue} 42% 46%)`,
        width: size,
        height: size,
      }}
      aria-hidden="true"
    >
      {deriveBotAvatarLabel(name)}
    </span>
  );
}

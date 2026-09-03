"use client";

/**
 * BotCharacterAvatar — grok-style vector character avatar (Plan 483 P1.2).
 *
 * A bot avatar is a (shape, color) token pair rendered as an SVG
 * character, mirroring grok-bot's AVATAR_SHAPES × AVATAR_COLORS system.
 * Bots without configured tokens fall back to the deterministic-hue
 * initial circle (previous behavior) so legacy config agents keep
 * rendering.
 */

import React from "react";
import {
  botAvatarColorHex,
  isKnownAvatarShape,
  type BotAvatarShape,
} from "@/lib/bot-avatar";
import { deriveBotAvatarLabel, deriveBotContactHue } from "./bot-contacts";

/** Per-shape SVG nodes in a 32×32 viewBox. */
const SHAPE_NODES: Record<BotAvatarShape, React.ReactNode> = {
  blob: (
    <path d="M16 3c6.2 0 12 4.2 13 10.2 1 6.1-2.2 12-8.2 14.2-6 2.2-13 1-16-5S2.6 10.4 8 6.2C10.8 4 13 3 16 3z" />
  ),
  pebble: (
    <path d="M6.5 20.5c-2.2-5.2 1.8-11.2 7.8-13.2s12.8-1 14.8 3-1 9.8-7 12.8-13.4 2.6-15.6-2.6z" />
  ),
  squircle: <rect x="4" y="4" width="24" height="24" rx="9" />,
  tablet: <rect x="9" y="3" width="14" height="26" rx="7" />,
  wedge: <path d="M4.5 26.5L16 4l11.5 22.5c-7.6 3-15.4 3-23 0z" />,
  hex: <polygon points="16,2.5 28,9.25 28,22.75 16,29.5 4,22.75 4,9.25" />,
  cloud: (
    <path d="M10 25c-4.4 0-7.5-2.8-7.5-6.2 0-3 2.6-5.6 6-6C9.4 7.8 13.3 5 18 5c5.8 0 10.5 4 10.5 9.2 2.4.8 4 2.7 4 4.9 0 3.3-3 5.9-7 5.9H10z" />
  ),
  teardrop: (
    <path d="M16 2.8c4 6.2 10.2 10.4 10.2 16.6a10.2 10.2 0 1 1-20.4 0C5.8 13.2 12 9 16 2.8z" />
  ),
};

export interface BotCharacterAvatarProps {
  name: string;
  agentId: string;
  avatarShape?: string;
  avatarColor?: string;
  size?: number;
}

export function BotCharacterAvatar({
  name,
  agentId,
  avatarShape,
  avatarColor,
  size = 26,
}: BotCharacterAvatarProps) {
  const hex = botAvatarColorHex(avatarColor);

  if (isKnownAvatarShape(avatarShape) && hex) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        aria-hidden="true"
        className="bot-character-avatar"
      >
        <g fill={hex}>{SHAPE_NODES[avatarShape]}</g>
      </svg>
    );
  }

  // Fallback: deterministic-hue initial circle (legacy config agents).
  const hue = deriveBotContactHue(agentId);
  return (
    <span
      className="bot-contact-avatar"
      style={{ backgroundColor: `hsl(${hue} 42% 46%)`, width: size, height: size }}
      aria-hidden="true"
    >
      {deriveBotAvatarLabel(name)}
    </span>
  );
}

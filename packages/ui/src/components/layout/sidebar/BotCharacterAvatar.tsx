"use client";

/**
 * BotCharacterAvatar — bot avatar renderer.
 *
 * The avatar is the animated agent face (`@/components/agent-face`):
 * a fixed superellipse tile driven by the bloub character engine. Identity is
 * the body color — explicit token color first, else the deterministic per-agent
 * hue. An idle bot dozes (somnolent); a working one collapses into the
 * thinking dots, so the streaming state reads straight off the avatar.
 */

import { AgentFace } from "@/components/agent-face/AgentFace";
import { botAvatarColorHex } from "@/lib/bot-avatar";
import { deriveBotContactHue } from "./bot-contacts";

export interface BotCharacterAvatarProps {
  name: string;
  agentId: string;
  /** Color token id for the face body (explicit token wins over hue). */
  avatarColor?: string;
  size?: number;
  /** While true the face runs the thinking animation. */
  working?: boolean;
}

export function BotCharacterAvatar({
  agentId,
  avatarColor,
  size = 38,
  working,
}: BotCharacterAvatarProps) {
  return (
    <AgentFace
      size={size}
      color={botContactColorHex(agentId, avatarColor) ?? "#777777"}
      status={working ? "running" : undefined}
      className="bot-character-avatar"
    />
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

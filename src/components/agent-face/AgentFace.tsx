"use client";

/**
 * AgentFace — RESTORATION STUB (plan 572 unblock, 2026-09-27).
 *
 * The original component was imported by 20beb534 (bot avatar editor)
 * but never committed on any ref, which broke `build:web` at HEAD and,
 * with it, plan 572's Phase 6 packaging gate. This implementation is
 * derived EXCLUSIVELY from the three surviving call sites
 * (BotCharacterAvatar / WorkflowGraph / run-display stage-columns):
 *
 *   <AgentFace size={20} status={faceStatusOf(status)} color={accent} />
 *   <AgentFace size={size} color={hex} status={working ? "running" : undefined}
 *              className="bot-character-avatar" />
 *   type AgentFaceStatus = 'pending' | 'running' | 'done' | 'failed'
 *
 * and the documented design contract in BotCharacterAvatar's header
 * (animated agent face on a fixed superellipse tile; idle bot dozes,
 * working bot collapses into the thinking dots). It wraps the existing
 * bloub orb engine (`@/orb/bot/BloubOrb`) — the face IS the bot
 * character, not a new drawing. When the upstream author's original
 * file resurfaces, this stub should be replaced with it (drop-in: the
 * props surface is exactly the three call sites).
 */

import { BloubOrb } from '@/orb/bot/BloubOrb';
import type { StateId } from '@/orb/bot/states';
import { COLORS, type ColorId } from '@/orb/bot/skins';

export type AgentFaceStatus = 'pending' | 'running' | 'done' | 'failed';

/** Status → orb state (see the design contract in the module header). */
const STATUS_TO_STATE: Record<AgentFaceStatus, StateId> = {
  pending: 'idle',
  running: 'thinking',
  done: 'wink',
  failed: 'exclaim',
};

export interface AgentFaceProps {
  /** Rendered tile size in CSS px. */
  size?: number;
  /** Body colour as a hex string — mapped to the nearest engine palette id. */
  color: string;
  /** Life status; undefined = idle (the bot dozes). */
  status?: AgentFaceStatus;
  className?: string;
}

/**
 * Map an arbitrary hex to the nearest engine `ColorId` by squared RGB
 * distance. The engine palette is fixed (13 ids); callers hand us
 * identity hexes (deterministic per-agent hues), so this keeps every
 * agent visually distinct while staying on the character's palette.
 */
export function nearestColorId(hex: string): ColorId {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'duya';
  const r = parseInt(m[1]!.slice(0, 2), 16);
  const g = parseInt(m[1]!.slice(2, 4), 16);
  const b = parseInt(m[1]!.slice(4, 6), 16);
  let best: ColorId = 'duya';
  let bestDist = Infinity;
  for (const c of COLORS) {
    const cr = parseInt(c.hex.slice(1, 3), 16);
    const cg = parseInt(c.hex.slice(3, 5), 16);
    const cb = parseInt(c.hex.slice(5, 7), 16);
    const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb);
    if (d < bestDist) {
      bestDist = d;
      best = c.id;
    }
  }
  return best;
}

/**
 * The tile behind the face. The engine's eyes are real holes showing
 * `paper`, so the tile paints exactly the colour it receives —
 * otherwise the sockets read as a differently coloured patch.
 */
const TILE_PAPER = '#f3eeff';

export function AgentFace({ size = 24, color, status, className }: AgentFaceProps) {
  const state: StateId = status ? STATUS_TO_STATE[status] : 'sleep';
  return (
    <span
      className={className}
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '38%',
        background: TILE_PAPER,
        overflow: 'hidden',
        display: 'inline-block',
        lineHeight: 0,
        flexShrink: 0,
      }}
    >
      <BloubOrb size={size} state={state} color={nearestColorId(color)} paper={TILE_PAPER} fps={30} />
    </span>
  );
}

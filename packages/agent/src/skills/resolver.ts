/**
 * packages/agent/src/skills/resolver.ts
 *
 * Single source of truth for skill winner resolution.
 *
 * Phase 3B-0.2: GUI `skills:list` and Agent runtime `SkillRegistry` MUST
 * use the same winner rule. This module is the shared resolver.
 *
 * Precedence (v0): user > plugin > bundled
 *
 * Inputs are skill candidates from each source layer; output is the
 * available set (one winner per logical name) and the name-scoped
 * `enabled` effective state.
 *
 * This module is pure: no filesystem, no I/O, no electron. It takes
 * pre-classified candidates and returns a deterministic result.
 */

export type SkillSourceV0 = 'bundled' | 'user' | 'plugin';

export interface SkillCandidate {
  name: string;
  source: SkillSourceV0;
  /** Plugin id, required for source=plugin candidates. */
  pluginId?: string;
  /** Whether the candidate's on-disk marker was present (provenance). */
  hasMarker?: boolean;
}

export interface AvailableSkill {
  /** Logical name (directory name). */
  name: string;
  /** Resolved source. */
  source: SkillSourceV0;
  /** Plugin id if source=plugin. */
  pluginId?: string;
}

/** Precedence: higher number wins. Locked for v0. */
export const PRECEDENCE: Record<SkillSourceV0, number> = {
  user: 3,
  plugin: 2,
  bundled: 1,
};

/**
 * Choose the winner for a single logical name. Returns null if no
 * candidates. Ties broken by input order (caller's responsibility to
 * pass candidates in a stable order).
 */
export function pickWinner(candidates: SkillCandidate[]): SkillCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates) {
    if (PRECEDENCE[c.source] > PRECEDENCE[best.source]) {
      best = c;
    }
  }
  return best;
}

/**
 * Resolve all candidates into the available set. One winner per
 * logical name. Shadowed candidates are NOT in the result.
 */
export function resolveAvailable(candidates: SkillCandidate[]): AvailableSkill[] {
  const byName = new Map<string, SkillCandidate>();
  for (const c of candidates) {
    const existing = byName.get(c.name);
    if (!existing) {
      byName.set(c.name, c);
      continue;
    }
    if (PRECEDENCE[c.source] > PRECEDENCE[existing.source]) {
      byName.set(c.name, c);
    }
  }
  return Array.from(byName.values()).map((c) => ({
    name: c.name,
    source: c.source,
    pluginId: c.pluginId,
  }));
}

/**
 * Compute the `enabled` effective state for an available winner.
 * `enabled` is name-scoped: same logical name shares a single override.
 * Returns true unless the override explicitly sets false.
 */
export function isWinnerEnabled(
  winner: AvailableSkill,
  overrides: Record<string, boolean>,
): boolean {
  return overrides[winner.name] !== false;
}
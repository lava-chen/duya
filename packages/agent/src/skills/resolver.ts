/**
 * packages/agent/src/skills/resolver.ts
 *
 * Single source of truth for skill winner resolution.
 *
 * Phase 3B-0.3: distinguishes `origin` (provenance) from
 * `effectivePrecedence` (winner decision weight). A customized
 * bundled skill competes at the user level so it cannot be
 * shadowed by a later-installed plugin.
 *
 * Precedence (v0): user (4) > customized-bundled (4) > plugin (3)
 *                  > plain bundled (2) > unmarked (1)
 *
 * Pure: no filesystem, no I/O, no electron. Takes pre-classified
 * candidates and returns a deterministic result.
 */

export type SkillOrigin = 'bundled' | 'user' | 'project' | 'custom' | 'plugin' | 'system' | 'agent';

export interface SkillCandidate {
  /** Logical name (directory name). */
  name: string;
  /** Original source / provenance. */
  origin: SkillOrigin;
  /** Plugin id, required for origin=plugin candidates. */
  pluginId?: string;
  /**
   * True iff this is a bundled-derived skill whose current content
   * hash differs from the canonical bundled hash. Unused for
   * non-bundled origins.
   */
  customized?: boolean;
  /**
   * True iff this candidate has a .duya-origin.json marker on disk.
   * Used as a defensive fallback for unmarked entries.
   */
  hasMarker?: boolean;
}

export interface AvailableSkill {
  name: string;
  origin: SkillOrigin;
  customized: boolean;
  pluginId?: string;
  /** Internal: the precedence used in winner resolution. */
  effectivePrecedence: number;
}

/** Compute the effective precedence from origin and customized. */
export function effectivePrecedenceOf(c: SkillCandidate): number {
  // System-level skills always win (plan 414): the agent registry loads them
  // last and they cannot be disabled or shadowed.
  if (c.origin === 'system') return 6;
  // Custom skill_path is the last additional path loaded by the agent.
  if (c.origin === 'custom') return 5;
  // Bot-scoped skills (origin 'agent') outrank global user/project skills so
  // a bot's own directory shadows any same-named skill from the shared pool.
  if (c.origin === 'agent') return 4;
  if (c.origin === 'user') return 3;
  // Project skills share the user tier: cross-directory name collisions are
  // rare, and the agent registers project skills after user skills so the
  // project copy wins there; here ties resolve by discovery order.
  if (c.origin === 'project') return 3;
  if (c.origin === 'plugin') return 2;
  // origin === 'bundled'
  if (c.customized === true) return 3;
  // plain bundled
  if (c.hasMarker === false) return 1; // unmarked defensive fallback
  return 2;
}

/**
 * Choose the winner for a single logical name. Returns null if no
 * candidates. Ties broken by input order (caller's responsibility).
 */
export function pickWinner(candidates: SkillCandidate[]): AvailableSkill | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = effectivePrecedenceOf(best);
  for (const c of candidates) {
    const score = effectivePrecedenceOf(c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return {
    name: best.name,
    origin: best.origin,
    customized: best.origin === 'bundled' && best.customized === true,
    pluginId: best.pluginId,
    effectivePrecedence: bestScore,
  };
}

/**
 * Resolve all candidates into the available set. One winner per
 * logical name. Shadowed candidates are NOT in the result.
 */
export function resolveAvailable(candidates: SkillCandidate[]): AvailableSkill[] {
  const byName = new Map<string, { candidate: SkillCandidate; score: number }>();
  for (const c of candidates) {
    const score = effectivePrecedenceOf(c);
    const existing = byName.get(c.name);
    if (!existing || score > existing.score) {
      byName.set(c.name, { candidate: c, score });
    }
  }
  return Array.from(byName.values()).map(({ candidate, score }) => ({
    name: candidate.name,
    origin: candidate.origin,
    customized: candidate.origin === 'bundled' && candidate.customized === true,
    pluginId: candidate.pluginId,
    effectivePrecedence: score,
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
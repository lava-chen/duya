/**
 * packages/agent-core/src/skills/resolver.ts
 *
 * Single source of truth for skill winner resolution.
 *
 * Phase 3B-0.3: distinguishes `origin` (provenance) from
 * `effectivePrecedence` (winner decision weight). A customized
 * bundled skill competes at the user level so it cannot be
 * shadowed by a later-installed plugin.
 *
 * Precedence ladder (v0):
 *
 *   system > custom > agent > user = project = customized-bundled
 *          > plugin > plain bundled > unmarked
 *
 * The ladder is decided in TWO steps, and it needs both:
 *
 *  - `effectivePrecedenceOf` is the FIRST key. It is the public
 *    `effectivePrecedence` field consumers read, so its numbers are part of
 *    the contract.
 *  - `ladderPosition` is the SECOND key, and it decides only the pairs the
 *    first key leaves EQUAL. There is exactly one such pair that the
 *    ladder orders strictly: `plugin` against a plain bundled skill, which
 *    the score cannot separate because both are 2.
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
  // A plugin and a plain bundled skill both score 2. The ladder orders them
  // strictly -- `plugin > plain bundled` -- and `ladderPosition` is what
  // settles that pair; see `compareCandidates` for why the score alone
  // could not.
  if (c.origin === 'plugin') return 2;
  // origin === 'bundled'
  if (c.customized === true) return 3;
  // plain bundled
  if (c.hasMarker === false) return 1; // unmarked defensive fallback
  return 2;
}

/**
 * The candidate's place on the documented ladder.
 *
 * ## Why there is a second key at all
 *
 * `effectivePrecedenceOf` is the public number, and it is what most pairs
 * are decided by. It cannot separate ONE pair of the ladder: `plugin` and a
 * plain bundled skill are both 2, because the ladder has seven tiers and
 * the score has six distinct values.
 *
 * `pickWinner` used to break that tie by DISCOVERY ORDER, which is not a
 * neutral detail -- it decides whether a plugin's skill is visible at all.
 * The scanner reads the bundled skills directory BEFORE the plugins' (see
 * `packages/host/src/skills/skillService.ts`: bundled, then user, then
 * plugin), so in production a plugin's skill was ALWAYS shadowed by a
 * same-named built-in, and the Phase 3B-0 lock
 * (`docs/design-docs/cli-control-plane/roadmap.md`: `user = customized-bundled
 * > plugin > plain bundled`) was not what the product did.
 *
 * ## Why the numbers here are the DOCUMENTED ones
 *
 * The positions below are the ladder's own order, so this table cannot
 * disagree with the ladder about who outranks whom. It only ever decides
 * pairs the score leaves EQUAL, and for those it says what the ladder says.
 *
 * The genuine ties stay ties: `user`, `project` and a customized bundled
 * skill all sit at 5, so they are still resolved by discovery order, as the
 * comment on the `project` arm has always said.
 */
function ladderPosition(c: SkillCandidate): number {
  if (c.origin === 'system') return 8;
  if (c.origin === 'custom') return 7;
  if (c.origin === 'agent') return 6;
  if (c.origin === 'user') return 5;
  if (c.origin === 'project') return 5;
  if (c.origin === 'plugin') return 4;
  if (c.origin === 'bundled') {
    // The three bundled tiers are already separated by the score, so the
    // position only has to place them: a customized bundled skill shares
    // the user tier, a plain one sits under `plugin`, and the unmarked
    // fallback sits under that.
    if (c.customized === true) return 5;
    if (c.hasMarker === false) return 2;
    return 3;
  }
  return 1;
}

/**
 * Compare two candidates for the same logical name.
 *
 * The SCORE is the first key and the LADDER POSITION is the second, so the
 * comparison is a strict total preorder: a candidate that is equal on both
 * keys never replaces the incumbent, which is what keeps the genuine ties
 * (`user` vs `project`, `user` vs `customized-bundled`) resolved by
 * discovery order.
 */
function compareCandidates(a: SkillCandidate, b: SkillCandidate): number {
  const scoreDelta = effectivePrecedenceOf(a) - effectivePrecedenceOf(b);
  if (scoreDelta !== 0) return scoreDelta;
  return ladderPosition(a) - ladderPosition(b);
}

/**
 * Choose the winner for a single logical name. Returns null if no
 * candidates.
 *
 * The winner is the one that outranks the others on the ladder: the
 * precedence SCORE first, the ladder POSITION second (see
 * `compareCandidates`). A pair that is equal on BOTH keys is a genuine tie
 * -- `user` against `project`, or `user` against a customized bundled skill
 * -- and is broken by input order, which is the caller's responsibility.
 */
export function pickWinner(candidates: SkillCandidate[]): AvailableSkill | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = effectivePrecedenceOf(best);
  for (const c of candidates) {
    const score = effectivePrecedenceOf(c);
    if (compareCandidates(c, best) > 0) {
      best = c;
      bestScore = score;
    }
  }
  return {
    name: best.name,
    origin: best.origin,
    customized: best.origin === 'bundled' && best.customized === true,
    ...(best.pluginId !== undefined ? { pluginId: best.pluginId } : {}),
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
    if (!existing || compareCandidates(c, existing.candidate) > 0) {
      byName.set(c.name, { candidate: c, score });
    }
  }
  return Array.from(byName.values()).map(({ candidate, score }) => ({
    name: candidate.name,
    origin: candidate.origin,
    customized: candidate.origin === 'bundled' && candidate.customized === true,
    ...(candidate.pluginId !== undefined ? { pluginId: candidate.pluginId } : {}),
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
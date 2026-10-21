/**
 * decisions/policy.ts — threshold policy for typed decisions (plan 551 Phase 2).
 *
 * All thresholds are policy inputs, never licenses (jev research §3.2:
 * "Typed output guarantees the interface, not truth"). The gray zone is
 * the load-bearing part: probabilities inside the band are NOT resolved
 * by guessing — `evaluateNoul` returns 'uncertain' so the caller can
 * hand the judgment upward (复核 / strict confirmation / rules).
 *
 * Defaults come from jev-browser's published operating points (done ≥
 * 0.85 never false-done in 556 rounds; irreversible ≥ 0.6 with ~200
 * rounds / 0 false blocks) — they are starting points for calibration,
 * not universal values (design note #9: 阈值没有万能值).
 */

export interface DecisionPolicy {
  /** noul ≥ this → proposition accepted. */
  doneAt: number;
  /** noul ≤ this → proposition rejected. */
  rejectAt: number;
  /** (rejectAt, doneAt) is the gray band → 'uncertain'. */
  /** noul ≥ this → treat the action as potentially irreversible. */
  irreversibleAt: number;
  /** choice confidence below this → 'ambiguous', never a silent pick. */
  minTargetConfidence: number;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  doneAt: 0.85,
  rejectAt: 0.45,
  irreversibleAt: 0.6,
  minTargetConfidence: 0.8,
};

/** Gray band endpoints for a policy (rejectAt, doneAt). */
export function grayBand(policy: DecisionPolicy): { low: number; high: number } {
  return { low: policy.rejectAt, high: policy.doneAt };
}

/**
 * Resolve a noul probability against the policy.
 * Returns 'uncertain' inside the gray band — the caller must escalate
 * (re-ask stricter, surface for review, or fall back to rules), never
 * silently guess.
 */
export type NoulVerdict = 'yes' | 'no' | 'uncertain';

export function evaluateNoul(p: number, policy: DecisionPolicy = DEFAULT_DECISION_POLICY): NoulVerdict {
  if (!Number.isFinite(p) || p < 0 || p > 1) return 'uncertain';
  if (p >= policy.doneAt) return 'yes';
  if (p <= policy.rejectAt) return 'no';
  return 'uncertain';
}

/**
 * Top-k candidates from a choice distribution, sorted by probability.
 * Used to hand "distribution, not a guess" back to the planner when the
 * decision is ambiguous (jev-browser design note #7).
 */
export function topCandidates(
  distribution: Record<string, number>,
  k = 3,
): Array<{ option: string; p: number }> {
  return Object.entries(distribution)
    .map(([option, p]) => ({ option, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

/** Deep-merge a partial policy over the defaults (config surface). */
export function resolveDecisionPolicy(overrides?: Partial<DecisionPolicy>): DecisionPolicy {
  return { ...DEFAULT_DECISION_POLICY, ...overrides };
}

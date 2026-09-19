/**
 * decide/verdict-bridge.ts — decision-backed corroboration for the
 * action verdict ladder (plan 551 Phase 3, official "verify and
 * escalate" pattern).
 *
 * plan 519's `verdict/` answers "did my action land?" with a three-
 * state read-back. This bridge lets a DecisionClient CORROBORATE that
 * verdict: one noul over the read-back evidence, and anything that is
 * not clearly landed escalates (re-capture / verification subagent).
 * Failure of the decision backend returns null — the existing verdict
 * behavior is kept untouched (plan 551: Jev is an optional accelerator).
 */

import type { DecisionClient } from '@duya/ai';
import type { Verdict } from '../verdict/types.js';

export interface VerdictAssessment {
  /** True when the evidence does not clearly support "landed". */
  escalate: boolean;
  reason: string;
  /** P(the action landed) from the decision backend. */
  pLanded: number;
}

export interface VerdictBridgeThresholds {
  /** p below this → definitely escalate. Default 0.45. */
  lowAt: number;
  /** p from lowAt up to highAt is the gray band → escalate. */
  highAt: number;
}

export const DEFAULT_VERDICT_BRIDGE_THRESHOLDS: VerdictBridgeThresholds = {
  lowAt: 0.45,
  highAt: 0.85,
};

/**
 * Corroborate a backend verdict with one noul. Returns null when the
 * backend is unavailable or fails — callers keep the plain verdict.
 */
export async function assessVerdict(
  verdict: Verdict,
  client: DecisionClient,
  thresholds: VerdictBridgeThresholds = DEFAULT_VERDICT_BRIDGE_THRESHOLDS,
): Promise<VerdictAssessment | null> {
  try {
    const res = await client.decide({
      state: {
        verdict_effect: verdict.effect,
        element_changed: verdict.verified.elementChanged,
        new_focused_entity: verdict.verified.newFocusedEntity,
        fallback_used: verdict.fallbackUsed ?? false,
      },
      questions: {
        landed: {
          kind: 'noul',
          instructions:
            'A desktop action (click/type/key/scroll) was just executed and the OS read back ' +
            'the evidence below. How likely is it that the action actually took effect? ' +
            'Answer no when nothing observably changed.',
        },
      },
    });
    const answer = res.answers.landed;
    if (!answer || answer.kind !== 'noul') return null;
    const pLanded = answer.p;
    if (pLanded >= thresholds.highAt) {
      return { escalate: false, reason: 'evidence clearly supports the action landed', pLanded };
    }
    if (pLanded < thresholds.lowAt) {
      return { escalate: true, reason: 'evidence suggests the action did NOT land — re-capture', pLanded };
    }
    return { escalate: true, reason: `landing evidence inconclusive (p=${pLanded.toFixed(2)}) — verify before continuing`, pLanded };
  } catch {
    return null;
  }
}

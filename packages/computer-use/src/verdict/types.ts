/**
 * verdict/types.ts — structured action verdict (plan 519 §3.5 / A3).
 *
 * After a state-changing action (click / drag / type / key / set_value)
 * the backend performs a single OS-level read-back to tell the model
 * whether the action likely took effect. This replaces the binary
 * `ActionResult { ok, reason }` guess ("did my click land?") with a
 * three-state ladder the model can react to mechanically.
 *
 * Design constraints (plan 519):
 *   - One read-back per action, no infinite verify loop. The verdict is
 *     a single result; escalation is a recommendation, not a retry.
 *   - `fallbackUsed` surfaces Win32 UIPI degradation (§3.7): when a
 *     cross-window click had to fall back to `raise: true`, the model
 *     should know the operation may have moved focus.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';

/** Three-state outcome of a single action read-back. */
export type VerdictEffect = 'confirmed' | 'unverifiable' | 'suspected_noop';

export interface Verdict {
  /**
   * What the read-back believes happened.
   *   - confirmed        — verified effect (e.g. focused element changed).
   *   - unverifiable     — something changed but the intended effect can't
   *                        be confirmed from available signals.
   *   - suspected_noop   — nothing observably changed; likely a no-op.
   */
  effect: VerdictEffect;
  /** Raw evidence behind the verdict. */
  verified: {
    /** Whether the focused element's identity changed between before/after. */
    elementChanged: boolean;
    /** Focused entity observed right after the action (null if unavailable). */
    newFocusedEntity: FocusedEntity | null;
  };
  /**
   * Optional suggested follow-up. Not an instruction — the model decides
   * whether to act on it (e.g. re-capture to inspect visually).
   */
  escalation?: {
    recommended: 're-capture' | 'raise' | 'foreground';
    reason: string;
  };
  /** Time spent on the read-back in ms. */
  readbackMs?: number;
  /** True when the backend degraded the action (Win32 UIPI fallback). */
  fallbackUsed?: boolean;
}
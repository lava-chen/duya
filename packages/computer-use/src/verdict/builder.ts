/**
 * verdict/builder.ts — pure builders that turn read-back signals into a
 * Verdict (plan 519 §3.5 / A3).
 *
 * These are side-effect free so tests can exercise all three states from
 * fixtures. The Electron backend calls `buildClickVerdict` after a
 * mouse-op read-back; keyboard/text ops use `buildUnverifiableVerdict`
 * because a keystroke entering text never changes `FocusedEntity` and a
 * focus-diff would be a false negative.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';
import type { Verdict } from './types.js';

export interface BuildClickVerdictOptions {
  /**
   * Whether a screenshot-level visual change was detected between
   * before/after. Undefined when the caller performs no visual diff —
   * an unchanged focused entity is then treated as `suspected_noop`.
   */
  screenshotChanged?: boolean;
  /** Set when the backend had to fall back (Win32 UIPI degradation). */
  fallbackUsed?: boolean;
  /** Time spent on the read-back, for telemetry. */
  readbackMs?: number;
}

/**
 * Build a verdict for mouse ops (click / drag) by comparing the focused
 * entity captured before and after the action.
 *
 * Ladder (plan 519 §3.5):
 *   - no read-back signal at all (null before and after) → unverifiable
 *   - focused element changed          → confirmed
 *   - unchanged but a visual diff seen → unverifiable
 *   - unchanged and no diff            → suspected_noop (+ escalate re-capture)
 */
export function buildClickVerdict(
  before: FocusedEntity | null | undefined,
  after: FocusedEntity | null | undefined,
  opts: BuildClickVerdictOptions = {},
): Verdict {
  const a = before ?? null;
  const b = after ?? null;
  const elementChanged = fingerprint(a) !== fingerprint(b);

  const base: Verdict = {
    effect: 'unverifiable',
    verified: { elementChanged, newFocusedEntity: b },
    readbackMs: opts.readbackMs,
    fallbackUsed: opts.fallbackUsed,
  };

  if (a === null && b === null) {
    // Both read-backs came up empty — the bridge had no focused-entity
    // signal before or after the action. That is an observation gap, not
    // evidence the click did nothing: reporting `suspected_noop` here
    // misleads the model into re-issuing working clicks (observed live
    // 2026-09-11). Escalate to a re-capture instead.
    return {
      ...base,
      effect: 'unverifiable',
      escalation: {
        recommended: 're-capture',
        reason: 'read-back produced no focused-entity signal before or after the action; the effect cannot be judged — re-capture and inspect instead of assuming a no-op.',
      },
    };
  }

  if (elementChanged) {
    return { ...base, effect: 'confirmed' };
  }

  if (opts.screenshotChanged === true) {
    // Something updated on screen (menus, dialogs) but the focused
    // element didn't change identity — we can't confirm the intended
    // effect, and we can't call it a no-op.
    return {
      ...base,
      effect: 'unverifiable',
      escalation: {
        recommended: 're-capture',
        reason: 'focused element unchanged despite a visible change; re-capture to confirm the target state.',
      },
    };
  }

  // Unchanged focus and no visual-diff signal to the contrary.
  return {
    ...base,
    effect: 'suspected_noop',
    escalation: {
      recommended: 're-capture',
      reason: 'focused element did not change after the action; likely a no-op. Re-capture and inspect before retrying.',
    },
  };
}

/**
 * Build an honest `unverifiable` verdict for keyboard/text ops
 * (type / key / set_value / scroll). A keystroke landing on the focused
 * field does not change `FocusedEntity`, so a focus-diff would always
 * read as a false no-op. We surface the current focus only as context.
 */
export function buildUnverifiableVerdict(
  after: FocusedEntity | null | undefined,
  opts: Pick<BuildClickVerdictOptions, 'fallbackUsed' | 'readbackMs'> = {},
): Verdict {
  return {
    effect: 'unverifiable',
    verified: {
      elementChanged: false,
      newFocusedEntity: after ?? null,
    },
    readbackMs: opts.readbackMs,
    fallbackUsed: opts.fallbackUsed,
  };
}

/**
 * Stable-enough identity fingerprint for a FocusedEntity. Two snapshots
 * of the "same" element serialize identically; a real re-target (new
 * window / element) yields a different fingerprint.
 */
function fingerprint(entity: FocusedEntity | null): string {
  return JSON.stringify(entity ?? null);
}
/**
 * win32-injection.ts — background-priority click injection (plan 519 §3.7 / C1).
 *
 * Background rule: a click must not steal focus from the user. The normal
 * path is `nut.js.mouse.setPosition` + `mouse.click`, which moves the OS
 * cursor and can pull a different window to the foreground. This module
 * provides the decision logic for when to inject the click programmatically
 * instead:
 *
 *   - same window            → the default nut.js path (no focus change risk)
 *   - different window       → inject into the target HWND without raising
 *   - cross-process + UIPI   → fall back to raise; surface `fallbackUsed`
 *
 * All native Win32 calls (GetForegroundWindow, WindowFromPoint) go through
 * the injectable `Win32NativeAdapter` so tests exercise the decision ladder
 * headlessly. Production wires the real user32 calls in
 * `computer-use-backend.ts`.
 */

/**
 * Minimal subset of user32 we depend on. Tests inject a stub; production
 * wires `GetForegroundWindow` / `WindowFromPoint` via the `koffi` module or
 * the OSContextBridge foreground snapshot.
 */
export interface Win32NativeAdapter {
  /**
   * Current foreground (active) top-level window handle, or null when
   * unavailable (headless / non-Windows). Maps to user32 GetForegroundWindow.
   */
  getForegroundWindow(): number | null;
  /**
   * Top-level window handle under the given logical screen point, or null.
   * Maps to user32 WindowFromPoint (resolved to the root via GetAncestor).
   */
  windowFromPoint(x: number, y: number): number | null;
}

/**
 * Decision about how to deliver a pointer action without disrupting the
 * user's foreground window.
 */
export type ClickInjectionDecision =
  /** Target and foreground are the same window — use the normal path. */
  | { mode: 'same-window' }
  /** Target window is behind the foreground but reachable — inject directly. */
  | { mode: 'background-direct'; targetHwnd: number }
  /**
   * Cross-process and the target cannot be injected without raising —
   * the caller should fall back to `raise` and flag `fallbackUsed`.
   */
  | {
      mode: 'background-raise';
      targetHwnd: number;
      fallbackUsed: true;
      recommended: 'raise';
      reason: string;
    }
  /** No target window could be resolved under the point. */
  | { mode: 'no-target'; fallbackUsed: true; recommended: 're-capture'; reason: string };

export interface ClickInjectionInput {
  /** Foreground window handle (GetForegroundWindow), nullable. */
  foreground: number | null;
  /** Target window handle under the intended click point, nullable. */
  target: number | null;
}

/**
 * Decide how to inject a mouse click for a given target so it does not
 * steal focus (plan 519 §3.7, default `background`).
 *
 * Ladder:
 *   - no target resolved            → `no-target` (re-capture)
 *   - target == foreground          → `same-window` (safe default path)
 *   - target elsewhere, foreground known → inject directly (no raise)
 *   - foreground unknown            → conservative raise fallback
 */
export function decideClickInjection(
  input: ClickInjectionInput,
): ClickInjectionDecision {
  const { foreground, target } = input;
  if (target === null || target === 0) {
    return {
      mode: 'no-target',
      fallbackUsed: true,
      recommended: 're-capture',
      reason: 'no window resolved under the click point; re-capture before retrying.',
    };
  }
  if (foreground !== null && foreground !== 0 && foreground === target) {
    return { mode: 'same-window' };
  }
  if (foreground !== null && foreground !== 0) {
    // Target is a different, known window — inject without raising.
    return {
      mode: 'background-direct',
      targetHwnd: target,
    };
  }
  // We could not see the foreground window (headless / late probe). Raise is
  // the safest way to guarantee the target receives the click.
  return {
    mode: 'background-raise',
    targetHwnd: target,
    fallbackUsed: true,
    recommended: 'raise',
    reason: 'foreground window unknown; raising target to guarantee delivery may move focus.',
  };
}

/**
 * Apply a click-injection decision to an existing read-back verdict so the
 * model knows the click may have moved focus (UIPI degradation surfaced
 * via `fallbackUsed`, plan 519 §3.7).
 */
export function applyInjectionToVerdict(
  verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } },
  decision: ClickInjectionDecision,
): void {
  if (decision.mode === 'background-raise' || decision.mode === 'no-target') {
    verdict.fallbackUsed = true;
  }
  if (
    (decision.mode === 'background-raise' || decision.mode === 'no-target') &&
    decision.recommended === 'raise' &&
    !verdict.escalation
  ) {
    verdict.escalation = {
      recommended: decision.recommended as 'raise',
      reason: decision.reason,
    };
  }
}
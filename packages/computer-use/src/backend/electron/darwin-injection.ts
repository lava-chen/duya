/**
 * darwin-injection.ts — background-priority injection ladder for macOS
 * (plan 572 D4, mirror of win32-injection.ts for plan 519 §3.7).
 *
 * Delivery rungs, background-first:
 *
 *   1. `ax-action`   — AXUIElementPerformAction by snapshot handle.
 *                      Works on background apps, never touches the
 *                      cursor or the activation state, and is the only
 *                      rung whose effect can be read back (the element
 *                      state is re-readable). Preferred whenever the
 *                      fresh capture carried a handle.
 *   2. `pid-event`   — CGEventPostToPid. Keyboard/scroll only: the
 *                      target process receives the event without being
 *                      activated. NO RAW PID MOUSE EVENTS: Chromium
 *                      filters pid-posted mouse events at the IPC
 *                      boundary (missing click-state stamps), so this
 *                      rung is intentionally unavailable for clicks.
 *   3. `foreground`  — activate + raise + the normal nut.js cursor
 *                      path. Guaranteed delivery, may move the user's
 *                      focus; `fallbackUsed` is surfaced on the verdict.
 *
 * All decisions are pure functions over injected inputs so the ladder
 * is testable headlessly; production wires the AX helper client in
 * `computer-use-backend.ts` / `electron/ipc/computer-use.ts`.
 */

/** Chromium-family process names — pid-posted mouse events are filtered. */
const CHROMIUM_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'chrome',
  'google chrome',
  'chromium',
  'msedge',
  'microsoft edge',
  'brave browser',
  'brave',
  'arc',
  'vivaldi',
  'opera',
  'electron',
]);

/** Best-effort Chromium detection from a process name. */
export function isChromiumProcess(processName: string | null | undefined): boolean {
  if (!processName) return false;
  return CHROMIUM_PROCESS_NAMES.has(processName.trim().toLowerCase());
}

/**
 * Decision about how to deliver a click on macOS.
 *
 * Note there is NO `pid-event` rung for clicks by design — see the
 * module doc. Background click delivery is either AX action (rung 1)
 * or the explicit foreground fallback (rung 3).
 */
export type DarwinClickDecision =
  | { mode: 'ax-action'; pid: number; handle: string }
  | {
      mode: 'foreground';
      fallbackUsed: true;
      reason: string;
    }
  | {
      mode: 'no-target';
      fallbackUsed: true;
      recommended: 're-capture';
      reason: string;
    };

export interface DarwinClickInput {
  /** AX snapshot handle of the target element (fresh capture), if any. */
  handle?: string | null;
  /** PID owning the element (resolved alongside the handle). */
  pid?: number | null;
  /** Whether the click can be delivered by coordinates at all. */
  hasClickPoint: boolean;
}

/**
 * Decide how to deliver a click (plan 572 D4):
 *   - handle + pid known      → `ax-action` (background, read-backable)
 *   - coordinates resolvable  → `foreground` (fallbackUsed surfaced)
 *   - neither                 → `no-target` (re-capture)
 */
export function decideDarwinClick(input: DarwinClickInput): DarwinClickDecision {
  if (input.handle && typeof input.pid === 'number' && input.pid > 0) {
    return { mode: 'ax-action', pid: input.pid, handle: input.handle };
  }
  if (input.hasClickPoint) {
    return {
      mode: 'foreground',
      fallbackUsed: true,
      reason:
        'no AX handle on the fresh capture; using the foreground cursor path (may activate the target app).',
    };
  }
  return {
    mode: 'no-target',
    fallbackUsed: true,
    recommended: 're-capture',
    reason: 'no AX handle and no resolvable click point; re-capture before retrying.',
  };
}

/**
 * Decision about how to deliver a keyboard / scroll gesture.
 *
 * `pid-event` (CGEventPostToPid) is only proposed when the target pid
 * is known AND differs from the foreground — typing into the already
 * focused app should keep the normal foreground path (unicode-string
 * typing in nut.js handles IME-adjacent text better than raw keycodes).
 */
export type DarwinKeyDecision =
  | { mode: 'foreground' }
  | { mode: 'pid-event'; pid: number; fallbackUsed: false };

export interface DarwinKeyInput {
  /** Foreground pid (helper `fg`), nullable when unknown. */
  foregroundPid: number | null;
  /** Target pid for the gesture, nullable when unknown. */
  targetPid: number | null;
  /** True when the text payload contains characters outside the ASCII range. */
  nonAscii?: boolean;
}

export function decideDarwinKeyDelivery(input: DarwinKeyInput): DarwinKeyDecision {
  const { foregroundPid, targetPid } = input;
  if (
    typeof targetPid === 'number' &&
    targetPid > 0 &&
    typeof foregroundPid === 'number' &&
    foregroundPid > 0 &&
    foregroundPid !== targetPid &&
    input.nonAscii !== true
  ) {
    // Background delivery for keyboard/scroll is reliable; unicode
    // payloads stay on the foreground path (CGEventKeyboardSetUnicode
    // strings are ignored by some frameworks — keymap note).
    return { mode: 'pid-event', pid: targetPid, fallbackUsed: false };
  }
  return { mode: 'foreground' };
}

/**
 * Surface a delivery decision on the verdict shape the agent reads
 * (plan 519 §3.7 parity with `applyInjectionToVerdict`). The AX rung
 * does NOT set fallbackUsed — it is the preferred path, not a
 * degradation.
 */
export function applyDarwinDecisionToVerdict(
  verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } },
  decision: DarwinClickDecision | DarwinKeyDecision,
): void {
  if (decision.mode === 'foreground') {
    verdict.fallbackUsed = true;
    if (!verdict.escalation && 'reason' in decision) {
      verdict.escalation = { recommended: 'background', reason: decision.reason };
    }
  }
  if (decision.mode === 'no-target') {
    verdict.fallbackUsed = true;
    if (!verdict.escalation) {
      verdict.escalation = {
        recommended: decision.recommended,
        reason: decision.reason,
      };
    }
  }
}

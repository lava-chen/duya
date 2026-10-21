// ipc/trusted-sender-core.ts
// The PURE half of plan 583 / ISS-30's trusted-sender decision.
//
// ## Why this file exists
//
// `trusted-sender.ts` already had this split on purpose — its own header says
// `evaluateTrustedSender` is pure so it can be exhaustively unit-tested without
// an Electron runtime, and `assertTrustedSender` is the thin adapter. What the
// file did NOT have was a module boundary: `assertTrustedSender` needs
// `getMainWindow()`, so importing the pure decision ALSO imported
// `core/window-manager`, which imports `electron`.
//
// That made the decision unusable by anything that is not the Electron main
// process — notably the Control Plane (plan 587 C6.1), which must decide
// whether a `db:request` sender may speak, and which is deliberately
// constructible without an Electron runtime so its own behaviour is testable.
//
// So the pure decision moves here, with no Electron import anywhere in the
// module. `trusted-sender.ts` re-exports every name, so the existing call sites
// and `__tests__/trusted-sender.test.ts` are unaffected: there is still exactly
// ONE decision function, and the second trusted-sender check C6.1 forbids is
// still forbidden. What changed is that the one decision is now reachable
// without booting Electron.

/** Why a sender was refused. Surfaced in the audit log, never to the renderer. */
export type TrustedSenderRejection =
  /** No main window exists, or the sender is not it (auxiliary window or guest). */
  | 'unknown_window'
  /** The message came from an iframe inside the main window, not its top frame. */
  | 'subframe'
  /** The top frame is not on the app's own origin. */
  | 'foreign_origin';

export interface TrustedSenderFacts {
  /**
   * `webContents.id` of the process that sent the message. For a `<webview>`
   * guest this is the GUEST's webContents, not the main window's — which is
   * why this single check already refuses guests and auxiliary windows.
   */
  senderId: number;
  /**
   * `WebFrameMain.routingId` of the sending frame. `null` when the frame
   * could not be identified at all.
   */
  frameRoutingId: number | null;
  /**
   * `WebFrameMain.routingId` of the sending webContents' MAIN frame. `null`
   * when it could not be identified.
   *
   * This is what "the main frame" actually means, and it is NOT a constant.
   * Electron allocates frame ids per renderer process: measured on Electron
   * 44, a freshly created BrowserWindow's main frame reports routing id 1,
   * and the id changes again after a reload. So "is this the top frame" has
   * to be answered by COMPARING against the sender's own main frame — never
   * by comparing against a magic number. (Electron's own docs guarantee that
   * distinct `WebFrameMain` instances for the same frame share a
   * `routingId`, which is what makes the comparison sound.)
   */
  mainFrameRoutingId: number | null;
  /** The sending frame's URL, used only to confirm the app origin. */
  frameUrl: string | null;
}

export interface TrustedSenderOptions {
  /**
   * Origins the top frame may be on. Defaults to the main window's current
   * origin, read at call time. Pass an explicit list only when a known
   * dev/preview origin is expected.
   */
  allowedOrigins?: readonly string[];
}

export interface TrustedSenderConfig {
  mainWindowId: number | null;
  allowedOrigins: readonly string[];
}

export type TrustedSenderVerdict =
  | { ok: true }
  | { ok: false; reason: TrustedSenderRejection; detail: string };

/**
 * Pure decision. Accept only the main window's own main frame on an app
 * origin.
 *
 * Every branch fails closed, including the unknown ones: a missing routing id
 * or an origin we could not determine is refused rather than optimistically
 * allowed, because "we could not tell who this is" is not evidence of trust.
 */
export function evaluateTrustedSender(
  facts: TrustedSenderFacts,
  config: TrustedSenderConfig,
): TrustedSenderVerdict {
  if (config.mainWindowId === null) {
    return { ok: false, reason: 'unknown_window', detail: 'no main window is open' };
  }
  if (facts.senderId !== config.mainWindowId) {
    return {
      ok: false,
      reason: 'unknown_window',
      detail: `sender ${facts.senderId} is not the main window (${config.mainWindowId})`,
    };
  }
  if (facts.frameRoutingId === null) {
    return {
      ok: false,
      reason: 'subframe',
      detail: 'sender frame is unavailable; cannot confirm it is the main frame',
    };
  }
  if (facts.mainFrameRoutingId === null) {
    return {
      ok: false,
      reason: 'subframe',
      detail: 'sender webContents has no main frame to compare against',
    };
  }
  if (facts.frameRoutingId !== facts.mainFrameRoutingId) {
    return {
      ok: false,
      reason: 'subframe',
      detail: `frame routing id ${facts.frameRoutingId} is not the main frame (${facts.mainFrameRoutingId})`,
    };
  }
  if (config.allowedOrigins.length === 0) {
    return {
      ok: false,
      reason: 'foreign_origin',
      detail: 'no app origin is available to compare against',
    };
  }
  let origin: string;
  try {
    origin = new URL(facts.frameUrl ?? '').origin;
  } catch {
    return { ok: false, reason: 'foreign_origin', detail: `unparseable frame url ${facts.frameUrl}` };
  }
  if (origin === 'null' || !config.allowedOrigins.includes(origin)) {
    return { ok: false, reason: 'foreign_origin', detail: `frame origin ${origin} is not an app origin` };
  }
  return { ok: true };
}

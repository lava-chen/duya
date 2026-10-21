// electron/core/webview-guard.ts
// Plan 583 / ISS-15: a main-process floor on `<webview>` webPreferences.
//
// The main window enables `webviewTag`, so the renderer decides every
// webPreference of every guest. Without `will-attach-webview`, that includes
// `nodeintegration`, `nodeintegrationinworker`, `nodeintegrationinsubframes`
// and `websecurity` — so a single compromised or XSS'd renderer could ask for
// a guest with Node in it, or with the same-origin policy switched off, and
// the main process would grant it.
//
// Electron's guidance is explicit that `will-attach-webview` is the place to
// override renderer-requested preferences. This module is that override.
//
// Scope, and why it stops where it does:
//   - It pins only flags that GRANT privilege. A renderer asking for a
//     *less* privileged guest is never made more privileged by this floor.
//   - It strips `preload`. Electron documents this explicitly: a `<webview>`'s
//     preload runs WITH node integration, and `will-attach-webview` is the
//     recommended place to remove it. Neither webview in this repo
//     (`BrowserPanel.tsx`, `AgentBrowserTab.tsx`) sets one, so stripping can
//     only remove a capability no legitimate caller uses.
//   - It deliberately does NOT touch `sandbox`, `allowpopups` or `partition`.
//     Those are behavior, not privilege: forcing `sandbox: true` changes how
//     the guest's own JavaScript runs, and we cannot exercise a real
//     `<webview>` attach in CI (see the plan's ISS-15 note). Changing browser
//     behavior that cannot be verified is not a security fix. A wrong
//     `partition` is a cookie-correctness bug, not a privilege escalation.
//
// Split in two like `ipc/trusted-sender.ts`: `hardenWebviewPreferences` is
// PURE and exhaustively unit-testable, `attachWebviewGuard` is the thin
// adapter that wires it to a live WebContents.

import type { WebContents, WebPreferences } from 'electron';

/**
 * The floor. Every entry is the SAFE value, and every one of them is a flag
 * that hands power to page content when flipped the other way.
 */
export const WEBVIEW_PREFERENCE_FLOOR: Readonly<Record<string, boolean>> = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
});

/**
 * Force every floor entry onto `prefs` in place, and drop any `preload`
 * script. Returns the names of the fields the renderer had explicitly set to
 * something unsafe, so the caller can log what was actually asked for.
 *
 * An ABSENT field is written but NOT reported. `<webview partition="...">`
 * names no security attributes at all, and Electron resolves those to its own
 * safe defaults; reporting them would make every legitimate attach log a
 * false alarm. Only a field the renderer actually set to the unsafe value is
 * a real attempt worth surfacing.
 *
 * Mutates rather than clones: Electron reads the `webPreferences` object
 * passed to the event off this exact reference when the guest is created, so
 * a copy would be ignored — and the guard would silently do nothing.
 */
export function hardenWebviewPreferences(prefs: WebPreferences): string[] {
  const corrected: string[] = [];
  for (const [key, safeValue] of Object.entries(WEBVIEW_PREFERENCE_FLOOR)) {
    const current = prefs[key as keyof WebPreferences];
    if (current === safeValue) continue;
    if (current !== undefined) corrected.push(key);
    (prefs as Record<string, unknown>)[key] = safeValue;
  }
  if (prefs.preload) {
    delete prefs.preload;
    corrected.push('preload');
  }
  return corrected;
}

/**
 * Register the guard on a WebContents. Attach once per guest-capable
 * WebContents; re-attaching would apply the floor twice, which is harmless
 * but noisy.
 *
 * NOTE the second handler argument, not `params`. `params` is the raw
 * `<webview>` attribute map (`Record<string, string>`) and Electron does not
 * read guest preferences from it; mutating it is a silent no-op.
 */
export function attachWebviewGuard(
  contents: WebContents,
  onCorrected?: (fields: string[]) => void,
): void {
  contents.on('will-attach-webview', (event, webPreferences) => {
    const corrected = hardenWebviewPreferences(webPreferences);
    if (corrected.length > 0) {
      onCorrected?.(corrected);
    }
  });
}

/**
 * src/lib/providers/hooks/useOpenExternal.ts
 *
 * Plan 203 Phase 4.2: open an external URL in the user's default
 * browser. Wraps `window.open` with a conservative `https`-only
 * filter (Plan 203 D203.6).
 *
 * Why a hook:
 * - The hook is currently a stable function reference (`useCallback`
 *   over a closure). Future plans (tray menu integration, MacOS
 *   `openExternal` IPC fallback) can extend it without changing
 *   the call sites.
 *
 * Security:
 * - Only `https:` URLs are allowed. `http:` is rejected (mixed
 *   content protection). `javascript:` and `data:` URIs are
 *   explicitly rejected.
 * - URLs that do not parse are silently dropped (the caller does
 *   not need to handle a thrown error for malformed input).
 *
 * Browser vs Electron:
 * - In the renderer (this hook), `window.open(url, '_blank',
 *   'noopener,noreferrer')` opens in the user's browser.
 * - In the packaged Electron app, the renderer's `window.open`
 *   is still honored because Electron's `webContents.setWindowOpenHandler`
 *   delegates to the OS shell when configured. The current duya
 *   preload does not intercept `window.open`, so the call falls
 *   through to the default browser. Plan 209 can swap this for a
 *   dedicated `electronAPI.shell.openExternal` IPC call when a
 *   security review is complete.
 */

import { useCallback } from 'react';

function isSafeExternalUrl(input: string): boolean {
  // Trim whitespace. Reject empty.
  const url = input.trim();
  if (!url) return false;
  // Conservative: only `https:` is allowed in Phase 4.2.
  // `http:` is rejected (downgrade protection); `javascript:`,
  // `data:`, `blob:`, `file:` are explicitly rejected.
  return url.toLowerCase().startsWith('https://');
}

export function useOpenExternal(): (url: string) => void {
  return useCallback((url: string) => {
    if (!isSafeExternalUrl(url)) return;
    // `noopener,noreferrer` prevents the opened page from gaining
    // a reference to the renderer (tabnabbing defense).
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);
}

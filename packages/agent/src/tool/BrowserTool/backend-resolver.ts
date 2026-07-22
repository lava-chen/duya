/**
 * Backend resolver — pure function that decides which browser backend to use.
 * Extracted from BrowserTool.ensureConnection for testability.
 *
 * Degradation chain (auto mode):
 *   1. extension — Chrome extension connected via daemon WebSocket
 *   2. webview   — sidebar <webview> driven via webContents.debugger CDP
 *   3. fallback  — static HTTP fetch (no JS execution)
 */

import type { BrowserBackendMode } from './types.js';

export type { BrowserBackendMode } from './types.js';
export type ResolvedBackend = 'extension' | 'webview' | 'fallback' | 'human-like';

export interface BrowserToolConfig {
  mode: BrowserBackendMode;
  extensionProbeTimeoutMs: number;
}

export const DEFAULT_BROWSER_CONFIG: BrowserToolConfig = {
  mode: 'auto',
  extensionProbeTimeoutMs: 500,
};

/**
 * Resolve which backend to use based on mode and availability.
 *
 * - auto: extension → webview → fallback (full degradation chain)
 * - extension: always extension (no degradation, will throw if unavailable)
 * - built-in: always webview → fallback (skips extension entirely)
 * - human-like: webview wrapped with human-like mouse/keyboard events → fallback
 */
export function resolveBackend(
  mode: BrowserBackendMode,
  extensionOnline: boolean,
  rendererAvailable: boolean,
): ResolvedBackend {
  switch (mode) {
    case 'extension':
      return 'extension';
    case 'built-in':
      return rendererAvailable ? 'webview' : 'fallback';
    case 'human-like':
      return rendererAvailable ? 'human-like' : 'fallback';
    case 'auto':
    default:
      if (extensionOnline) return 'extension';
      if (rendererAvailable) return 'webview';
      return 'fallback';
  }
}

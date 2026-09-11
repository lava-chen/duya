/**
 * electron/factory.ts — default-backend singleton (plan 454 §5 Task B).
 *
 * Tracks the canonical DesktopBackend the agent tools should call.
 * Phase 1 keeps it `null` (Phase 2 wires the Electron impl when
 * computer-use-mode is enabled). Tests can replace it via
 * `setDefaultDesktopBackend()`; production code calls
 * `getDefaultDesktopBackend()` and throws if uninitialized.
 *
 * Platform selection (plan 519 §3.1 / D1):
 *   - `process.platform === 'win32'` → ElectronDesktopBackend (native, no
 *     stdio roundtrip) is the default.
 *   - otherwise, or when env `DUYA_CUA_DRIVER=external` is set → the
 *     McpCuaDriverBackend is constructed by `buildPlatformDefault()`.
 *   Production boot may pass an explicit backend via
 *   `setDefaultDesktopBackend()` and skip this logic entirely; the
 *   selection helpers are the fallback used when the agent layer does
 *   not know which platform it is on.
 *
 * This is intentionally NOT a wrapper that auto-creates a Noop — the
 * contract is "must be explicitly initialized", which surfaces
 * forgotten setup during Phase 2 wiring.
 */

import type { DesktopBackend } from '../types.js';
import { NoopDesktopBackend } from '../stub.js';
import { McpCuaDriverBackend } from '../mcp/cua-driver.js';

let _default: DesktopBackend | null = null;

/**
 * Get the default backend. Throws if not initialized — the agent
 * layer (Phase 2) must call `setDefaultDesktopBackend()` before any
 * OS tool fires. The Noop fallback at the bottom of this file is
 * intentionally NOT used here; it's a test-only escape hatch.
 */
export function getDefaultDesktopBackend(): DesktopBackend {
  if (!_default) {
    throw new Error(
      'DesktopBackend not initialized; call setDefaultDesktopBackend() first.',
    );
  }
  return _default;
}

/**
 * Replace the default backend. Used by:
 *   - Tests (any Noop variant).
 *   - Production boot (the Electron backend after wiring).
 */
export function setDefaultDesktopBackend(backend: DesktopBackend): void {
  _default = backend;
}

/**
 * Test-only: reset the singleton. Production code should not call
 * this — once initialized, the backend stays the same for the
 * process lifetime.
 */
export function __resetDefaultDesktopBackend(): void {
  _default = null;
}

/**
 * Convenience: get-or-create a Noop backend. Used by tests that
 * don't care about the singleton and just want a working handle.
 */
export function getOrCreateNoopBackend(): DesktopBackend {
  if (!_default) {
    _default = new NoopDesktopBackend();
  }
  return _default;
}

/**
 * Driver command + args for the `cua-driver` MCP backend. Overridable in
 * tests and by advanced users via env. `DUYA_CUA_DRIVER=external` forces
 * the MCP path on any platform (plan 519 §3.1 / D1).
 */
export function resolveCuaDriverCommand(): { command: string; args?: string[] } | null {
  const forced = process.env.DUYA_CUA_DRIVER;
  if (forced && forced !== 'external' && forced !== '') {
    // Allow a fully-qualified driver launcher, e.g. `python -m cua_driver`.
    const parts = forced.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      const [command, ...args] = parts;
      return { command: command!, args };
    }
  }
  const defaultCommand = 'cua-driver';
  return { command: defaultCommand };
}

/**
 * Decide whether the default backend should be the MCP driver.
 * Windows → Electron; non-Windows or `DUYA_CUA_DRIVER=external` → MCP.
 */
export function shouldUseMcpDriver(platform: NodeJS.Platform = process.platform): boolean {
  if (process.env.DUYA_CUA_DRIVER && process.env.DUYA_CUA_DRIVER.trim() !== '') {
    return true;
  }
  return platform !== 'win32';
}

/**
 * Build the MCP-backed backend on platforms that need it (non-Windows or
 * `DUYA_CUA_DRIVER=external`). Returns null when Windows without the env
 * override — those callers should use the Electron backend instead.
 */
export function buildPlatformDefault(): DesktopBackend | null {
  if (!shouldUseMcpDriver()) {
    return null;
  }
  const driver = resolveCuaDriverCommand();
  if (!driver) return null;
  return new McpCuaDriverBackend({ server: driver });
}
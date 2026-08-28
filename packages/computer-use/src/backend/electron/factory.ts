/**
 * electron/factory.ts — default-backend singleton (plan 454 §5 Task B).
 *
 * Tracks the canonical DesktopBackend the agent tools should call.
 * Phase 1 keeps it `null` (Phase 2 wires the Electron impl when
 * computer-use-mode is enabled). Tests can replace it via
 * `setDefaultDesktopBackend()`; production code calls
 * `getDefaultDesktopBackend()` and throws if uninitialized.
 *
 * This is intentionally NOT a wrapper that auto-creates a Noop — the
 * contract is "must be explicitly initialized", which surfaces
 * forgotten setup during Phase 2 wiring.
 */

import type { DesktopBackend } from '../types.js';
import { NoopDesktopBackend } from '../stub.js';

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
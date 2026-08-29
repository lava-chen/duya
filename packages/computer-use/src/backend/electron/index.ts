/**
 * electron/index.ts — Electron backend barrel (plan 454 §5 Task C).
 *
 * Re-exports the cross-platform Electron backend. Phase 1 has a
 * single impl (cross-platform via desktopCapturer + nut.js) — the
 * filename `win32.ts` is a historical artifact and may be renamed
 * once Phase 3 (macOS / Linux hardening) lands.
 */

export {
  ElectronDesktopBackend,
  type ElectronAdapter,
  type ElectronDesktopBackendOptions,
  type NutAdapter,
  type SharpAdapter,
  type SharpPipeline,
} from './win32.js';

import { ElectronDesktopBackend, type ElectronDesktopBackendOptions } from './win32.js';

/**
 * Factory: instantiate an ElectronDesktopBackend with the live
 * production dependencies. Callers must provide the `electron`
 * module (which is only available inside Electron), `sharp`, and
 * `@nut-tree-fork/nut-js`.
 *
 * Production usage (from electron/services/computer-use-backend.ts
 * in Phase 2): import electron, sharp, nut and pass them in.
 */
export function createElectronDesktopBackend(
  opts: ElectronDesktopBackendOptions,
): ElectronDesktopBackend {
  return new ElectronDesktopBackend(opts);
}
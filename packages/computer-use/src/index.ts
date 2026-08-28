/**
 * @duya/computer-use
 *
 * Desktop control backend for Computer Use Mode (plan 454).
 *
 * Phase 1 ships the platform-agnostic `DesktopBackend` interface plus
 * two impls:
 *   - `NoopDesktopBackend` — deterministic stub, used by tests and
 *     when computer-use-mode is disabled.
 *   - `ElectronDesktopBackend` — production impl that drives the
 *     desktop via @nut-tree-fork/nut-js (mouse/keyboard/wheel) and
 *     Electron `desktopCapturer` (screen capture), with sharp-based
 *     SOM overlay rendering.
 *
 * The package reads OSContextBridge (wake-agent plan 453) for the
 * focused entity + foreground app, but does NOT own the bridge — it
 * stays a passive consumer.
 *
 * Higher-level tool wiring (10 OS-side tools) lives in
 * `packages/agent/src/tool/OSTool/` (Phase 2).
 */

export * from './backend/index.js';
export * from './som/index.js';
export * from './safety/index.js';
export * from './memory/index.js';
export * from './approval/index.js';
export * from './access.js';
export * from './types.js';
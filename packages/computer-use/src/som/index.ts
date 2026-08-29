/**
 * som/index.ts — barrel (plan 454 §5 Task D).
 *
 * Re-exports the SOM overlay renderer and heuristic element detector.
 * Phase 2 wires both into the Electron backend's
 * `detectElements` / `renderOverlay` options.
 */

export {
  buildSomOverlaySvg,
  drawSomOverlay,
  drawSomOverlayOnto,
  type DrawSomOverlayOptions,
} from './overlay.js';

export {
  detectSomElements,
  type ElementDetectorInput,
} from './element-detector.js';
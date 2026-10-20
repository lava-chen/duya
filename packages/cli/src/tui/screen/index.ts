/**
 * Drawing surfaces for the TUI.
 *
 * `ScreenSurface` is the seam: five named regions, each taking a patch and
 * answering for its metrics. There is one implementation now (plan 615 Phase 7
 * retired the blessed one), but the seam stays — it is what lets a test drive a
 * frame without a terminal, and what would let a second backend exist without
 * the paint methods knowing.
 */

export type { RegionMetrics, RegionPatch, ScreenSurface, SurfaceRegion } from './types.js';
export { OwnScreenSurface, type OwnSurfaceOptions } from './own/surface.js';
export {
  createScreenSurface,
  selectScreenRenderer,
  type ScreenRenderer,
  type ScreenSurfaceFactoryOptions,
} from './factory.js';

/**
 * Drawing surfaces for the TUI.
 *
 * ScreenSurface is the seam. Import from here rather than reaching into an
 * implementation so the CLI can select one without changing its paint methods.
 */

export type { RegionMetrics, RegionPatch, ScreenSurface, SurfaceRegion } from './types.js';
export { BlessedScreenSurface, type BlessedSurfaceOptions } from './blessed-surface.js';
export { OwnScreenSurface, type OwnSurfaceOptions } from './own/surface.js';
export {
  createScreenSurface,
  selectScreenRenderer,
  type ScreenRenderer,
  type ScreenSurfaceFactoryOptions,
} from './factory.js';

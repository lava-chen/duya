import { OwnScreenSurface } from './own/surface.js';
import type { SurfaceSize } from './own/geometry.js';
import type { ScreenSurface } from './types.js';

export interface ScreenSurfaceFactoryOptions {
  readonly output: NodeJS.WritableStream;
  readonly getSize: () => SurfaceSize;
  readonly statusRows: number;
  readonly overlayWidth: string;
  readonly unicodeBox?: boolean;
}

/**
 * There is one renderer, and it is ours.
 *
 * `ScreenRenderer` survives as a single-member alias because it is still the
 * name of a real axis in the code that asks "which spelling do my styles use".
 * Keeping the alias means those signatures did not churn when the choice
 * disappeared.
 */
export type ScreenRenderer = 'own';

/**
 * The renderer is not selectable any more.
 *
 * `DUYA_TUI_RENDERER` was the rollback switch for the blessed screen path. That
 * path is gone (plan 615 Phase 7), so a value the user may still have in a shell
 * profile is IGNORED rather than honoured into a crash. The parameter stays so
 * embedding code and tests that pass a renderer keep compiling.
 */
export function selectScreenRenderer(_explicit?: ScreenRenderer): ScreenRenderer {
  return 'own';
}

export function createScreenSurface(options: ScreenSurfaceFactoryOptions): ScreenSurface {
  return new OwnScreenSurface({
    output: options.output,
    getSize: options.getSize,
    statusRows: options.statusRows,
    overlayWidth: options.overlayWidth,
    unicodeBox: options.unicodeBox,
  });
}

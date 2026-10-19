import { BlessedScreenSurface, type BlessedSurfaceOptions } from './blessed-surface.js';
import { OwnScreenSurface } from './own/surface.js';
import type { SurfaceSize } from './own/geometry.js';
import type { ScreenSurface } from './types.js';

export interface ScreenSurfaceFactoryOptions extends BlessedSurfaceOptions {
  readonly output: NodeJS.WritableStream;
  readonly getSize: () => SurfaceSize;
  readonly unicodeBox?: boolean;
  /** Explicit override for tests and embedding; the environment is the CLI switch. */
  readonly renderer?: ScreenRenderer;
}

export type ScreenRenderer = 'blessed' | 'own';

export function selectScreenRenderer(explicit?: ScreenRenderer): ScreenRenderer {
  if (explicit !== undefined) return explicit;
  // plan 615 Phase 0 (absorbing 614 Phase 6): `own` is the default renderer.
  // `DUYA_TUI_RENDERER=blessed` is the documented rollback switch, kept until
  // plan 615 Phase 7 deletes the blessed screen path.
  return process.env['DUYA_TUI_RENDERER'] === 'blessed' ? 'blessed' : 'own';
}

export function createScreenSurface(options: ScreenSurfaceFactoryOptions): ScreenSurface {
  const renderer = selectScreenRenderer(options.renderer);
  if (renderer === 'own') {
    return new OwnScreenSurface({
      program: options.program,
      output: options.output,
      getSize: options.getSize,
      statusRows: options.statusRows,
      overlayWidth: options.overlayWidth,
      unicodeBox: options.unicodeBox,
    });
  }
  return new BlessedScreenSurface({
    program: options.program,
    screenOptions: options.screenOptions,
    statusRows: options.statusRows,
    overlayWidth: options.overlayWidth,
  });
}

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
  return process.env['DUYA_TUI_RENDERER'] === 'own' ? 'own' : 'blessed';
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

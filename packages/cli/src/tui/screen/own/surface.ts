import type { BlessedProgram } from 'blessed';

import { changedRows, composeFrame, type SurfaceFrame } from './frame.js';
import { layoutRegion, screenRegions, type SurfaceSize } from './geometry.js';
import type { RegionMetrics, RegionPatch, ScreenSurface, SurfaceRegion } from '../types.js';

export interface OwnSurfaceOptions {
  readonly program: BlessedProgram;
  readonly output: NodeJS.WritableStream;
  readonly getSize: () => SurfaceSize;
  readonly statusRows: number;
  readonly overlayWidth: string;
  readonly unicodeBox?: boolean;
}

const OVERLAY_ONLY: readonly SurfaceRegion[] = ['overlay'];
const ALT_SCREEN_ENTER = '\u001b[?1049h\u001b[2J\u001b[H';
const ALT_SCREEN_LEAVE = '\u001b[0m\u001b[?1049l';

/**
 * An owned cell-grid renderer for the full-screen surface.
 *
 * Blessed still owns terminal input. This class only lays out the five regions,
 * composes their cells, and writes changed rows to the output stream.
 */
export class OwnScreenSurface implements ScreenSurface {
  private readonly attached = new Set<SurfaceRegion>();
  private readonly patches = new Map<SurfaceRegion, RegionPatch>();
  private readonly lastContent = new Map<SurfaceRegion, readonly string[]>();
  private previousFrame: SurfaceFrame | null = null;
  private readyFlag = false;
  private suspendedFlag = false;
  private activeFlag = false;
  private laidOutFlag = false;

  constructor(private readonly options: OwnSurfaceOptions) {}

  get ready(): boolean {
    return this.readyFlag;
  }

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  get rows(): number {
    return this.currentSize().rows;
  }

  attachAll(): void {
    if (this.readyFlag) return;
    this.createScreen(screenRegions());
  }

  ensure(): void {
    if (!this.readyFlag) {
      this.createScreen(OVERLAY_ONLY);
      return;
    }
    if (this.suspendedFlag) this.enter();
  }

  update(region: SurfaceRegion, patch: RegionPatch): void {
    this.createIfMissing();
    if (!this.attached.has(region)) return;
    const previous = this.patches.get(region) ?? {};
    const next: RegionPatch = {
      ...previous,
      ...patch,
      ...(patch.lines === undefined
        ? {}
        : { lines: [...patch.lines] }),
    };
    this.patches.set(region, next);
    if (patch.lines !== undefined) this.lastContent.set(region, [...patch.lines]);
  }

  measure(region: SurfaceRegion): RegionMetrics | null {
    if (!this.attached.has(region)) return null;
    if (!this.laidOutFlag) {
      const patch = this.patches.get(region);
      const configuredHeight =
        patch?.height ??
        (region === 'input'
          ? 3
          : region === 'status'
            ? this.options.statusRows
            : region === 'overlay'
              ? 7
              : region === 'completion'
                ? 3
                : 0);
      return {
        width: 0,
        innerWidth: 2,
        height: configuredHeight,
        innerHeight: 2,
        left: 0,
        top: 0,
        innerLeft: 1,
        innerTop: 1,
        laidOut: false,
      };
    }
    return layoutRegion(
      region,
      this.patches.get(region),
      {
        size: this.currentSize(),
        statusRows: this.options.statusRows,
        overlayWidth: this.options.overlayWidth,
        unicodeBox: this.options.unicodeBox,
      },
      true,
    ).metrics;
  }

  content(region: SurfaceRegion): readonly string[] {
    return this.lastContent.get(region) ?? [];
  }

  render(): void {
    if (!this.readyFlag || this.suspendedFlag) return;
    const composed = composeFrame(
      this.patches,
      this.attached,
      {
        size: this.currentSize(),
        statusRows: this.options.statusRows,
        overlayWidth: this.options.overlayWidth,
        unicodeBox: this.options.unicodeBox,
      },
      true,
    );
    const output = changedRows(this.previousFrame, composed.frame);
    this.previousFrame = composed.frame;
    this.laidOutFlag = true;
    if (output.length > 0) this.options.output.write(output);
  }

  enter(): void {
    if (!this.readyFlag || !this.suspendedFlag) return;
    this.enterAlternateBuffer();
  }

  leave(): void {
    if (!this.readyFlag || this.suspendedFlag) return;
    this.suspendedFlag = true;
    this.activeFlag = false;
    this.previousFrame = null;
    this.options.output.write(ALT_SCREEN_LEAVE);
  }

  destroy(): void {
    if (this.activeFlag) this.options.output.write(ALT_SCREEN_LEAVE);
    this.attached.clear();
    this.patches.clear();
    this.lastContent.clear();
    this.previousFrame = null;
    this.readyFlag = false;
    this.suspendedFlag = false;
    this.activeFlag = false;
    this.laidOutFlag = false;
  }

  private createIfMissing(): void {
    if (!this.readyFlag) this.createScreen(OVERLAY_ONLY);
  }

  private createScreen(regions: readonly SurfaceRegion[]): void {
    if (this.readyFlag) return;
    for (const region of regions) this.attached.add(region);
    this.readyFlag = true;
    this.enterAlternateBuffer();
  }

  private enterAlternateBuffer(): void {
    if (this.activeFlag) return;
    this.options.output.write(ALT_SCREEN_ENTER);
    this.options.program.enableMouse();
    this.activeFlag = true;
    this.suspendedFlag = false;
    this.previousFrame = null;
  }

  private currentSize(): SurfaceSize {
    const size = this.options.getSize();
    return {
      columns: Math.max(1, Math.floor(size.columns || 80)),
      rows: Math.max(1, Math.floor(size.rows || 24)),
    };
  }
}

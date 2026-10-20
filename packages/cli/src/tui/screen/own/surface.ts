import { changedRows, composeFrame, type SurfaceFrame } from './frame.js';
import { layoutRegion, screenRegions, type SurfaceSize } from './geometry.js';
import { enableMouseReporting } from '../../terminal/ansi.js';
import type { RegionMetrics, RegionPatch, ScreenSurface, SurfaceRegion } from '../types.js';
import type { SceneLine } from '../../core/span.js';

export interface OwnSurfaceOptions {
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
  private readonly lastContent = new Map<SurfaceRegion, readonly SceneLine[]>();
  private previousFrame: SurfaceFrame | null = null;
  private readyFlag = false;
  private suspendedFlag = false;
  private activeFlag = false;
  private laidOutFlag = false;
  /** A frame is already queued for the next microtask. */
  private renderScheduled = false;

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
      const size = this.currentSize();
      // Before the first frame there is no laid-out box to report, so answer
      // from the geometry the FIRST frame will use. Three traps are encoded
      // here, each of which bit once `own` became the default renderer
      // (plan 615 Phase 0):
      //
      //  - `width: 0` made `TUIApp.composerWidth()` fall through to its
      //    fallback on every frame, clipping typed text to nothing.
      //  - A fixed `innerHeight: 2` fed `inputChromeRows()` a value that
      //    disagreed with the borderStyle the same frame asked for, so the
      //    composer grew 2 rows per paint on a 2-row terminal until it sat at
      //    `top: -5`.
      //  - `innerWidth`/`innerHeight` must report what the border COSTS, which
      //    is blessed's `iwidth`/`iheight`, not how much is left inside. The
      //    content size is `width - innerWidth`; reporting the content width
      //    made `composerWidth()` answer 80-78 = 2 and clip typed text to two
      //    columns. Any framed region has this sign error, so the borderless
      //    case (where both conventions read 0) hides it.
      const layout = layoutRegion(
        region,
        patch,
        {
          size,
          statusRows: this.options.statusRows,
          overlayWidth: this.options.overlayWidth,
          unicodeBox: this.options.unicodeBox,
        },
        false,
      );
      return layout.metrics;
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

  content(region: SurfaceRegion): readonly SceneLine[] {
    return this.lastContent.get(region) ?? [];
  }

  /**
   * Compose and write the frame.
   *
   * The write is coalesced onto the microtask queue rather than done inline.
   * That is blessed's behaviour, and the reason it matters is not throughput:
   * a burst that arrives in one tick — a paste, or `input.write('rev')` — calls
   * `render()` once per character while `update()` has already been called
   * once per character. Writing each frame would put interim states on screen
   * that the caller never asked for and, worse, that its own assertions then
   * see (a completion list two keystrokes stale). Coalescing means the frame
   * is composed from the patches AS THEY ARE at flush time, so only the state
   * the user ends up looking at is ever written.
   *
   * `laidOut` flips at compose time, so `measure()` keeps the "not placed yet"
   * answer until a frame has actually been composed — the distinction the
   * cursor routine relies on.
   */
  render(): void {
    if (!this.readyFlag || this.suspendedFlag) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
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
    // The surface owns the modes it turns on. Mouse reporting used to be the
    // program's job only because a program existed; the sequence is the same
    // one, written by the same object that writes the screen.
    this.options.output.write(enableMouseReporting());
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

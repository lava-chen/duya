/**
 * The blessed-backed `ScreenSurface`.
 *
 * This is the implementation that exists today, unchanged in behaviour: the
 * same five boxes, the same geometry, the same repaint. Its only job is to stop
 * blessed's widget API from leaking into the paint methods, so that a second
 * implementation can be added beside it rather than through it.
 *
 * ## The one lazy thing
 *
 * The screen is created on demand. Inline mode must not build one in its
 * constructor, because `blessed.screen` enters the alternate buffer as a side
 * effect of construction and there is no way back out mid-frame — but an overlay
 * raised in inline mode still needs a real screen to live on. So `update` will
 * create it the first time anything is drawn, and `ready` reports whether that
 * has happened yet.
 */

import blessed from 'blessed';
import type { BlessedProgram, Widgets } from 'blessed';
import { lineToTags } from '../terminal/line.js';
import type { SceneLine } from '../core/span.js';

import type { RegionMetrics, RegionPatch, ScreenSurface, SurfaceRegion } from './types.js';

/** Blessed exposes these lifecycle methods at runtime but omits their types. */
type ManagedScreen = Widgets.Screen & { enter(): void; leave(): void };

/** The options object `TUIApp` already builds and publishes for its tests. */
export interface BlessedSurfaceOptions {
  readonly program: BlessedProgram;
  readonly screenOptions: Readonly<Record<string, unknown>>;
  /** Rows the status region occupies. One, today; named so the table below reads. */
  readonly statusRows: number;
  /** Percentage of the terminal width the centred overlay takes. */
  readonly overlayWidth: string;
}

type Box = Widgets.BoxElement;

/**
 * Per-region creation options.
 *
 * A table rather than five inline calls so the geometry can be read in one
 * place, and so a second implementation has exactly one thing to mirror.
 */
function regionSpec(
  options: BlessedSurfaceOptions,
  region: SurfaceRegion,
): Readonly<Record<string, unknown>> {
  const { statusRows } = options;
  switch (region) {
    case 'transcript':
      return {
        top: 0,
        left: 0,
        right: 0,
        bottom: 3 + statusRows,
        // NOT `scrollable`. The window is owned by `TranscriptModel` and applied
        // in `paintTranscript`, because blessed's scrollable measures against
        // `_clines`/`_pcontent`, which are only rebuilt by `parseContent` and
        // therefore lag the content by one coalesced render batch. Handing the
        // box a buffer taller than the screen and asking it to scroll is what
        // made a streaming answer appear frozen at the top with the newest lines
        // stranded below the fold.
        keys: false,
        vi: false,
        tags: true,
        style: { border: { fg: 'gray' } },
      };
    case 'input':
      return {
        bottom: statusRows,
        left: 0,
        right: 0,
        height: 3,
        keys: true,
        vi: true,
        tags: true,
        border: { type: 'line', left: false, right: false },
        style: { border: { fg: 'green' } },
      };
    case 'status':
      return {
        bottom: 0,
        left: 0,
        right: 0,
        height: statusRows,
        tags: true,
        content: '',
      };
    case 'overlay':
      return {
        top: 'center',
        left: 'center',
        width: options.overlayWidth,
        // Sized from the body on every paint; see `paintOverlay`.
        height: 7,
        hidden: true,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'yellow' } },
        keys: true,
        vi: true,
      };
    case 'completion':
      return {
        // Height is set on every paint from the visible row count; the box
        // starts hidden so it never reserves space the popup is not using.
        bottom: 3 + statusRows,
        left: 4,
        right: 4,
        height: 3,
        hidden: true,
        scrollable: false,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
      };
  }
}

/**
 * Append order, which is z-order: later boxes are drawn over earlier ones.
 *
 * This is the order the boxes were always created in, and it is load-bearing
 * rather than incidental. The overlay is centred, so the popup and the composer
 * are the only things that can overlap it — and a popup opened while an overlay
 * is up must still be readable, which it stops being if the overlay is appended
 * last and covers it.
 */
const APPEND_ORDER: readonly SurfaceRegion[] = [
  'transcript',
  'input',
  'status',
  'overlay',
  'completion',
];

/** What a lazily built screen gets: the overlay is the only reason one exists. */
const OVERLAY_ONLY: readonly SurfaceRegion[] = ['overlay'];

export class BlessedScreenSurface implements ScreenSurface {
  private screen: ManagedScreen | null = null;
  private readonly boxes = new Map<SurfaceRegion, Box>();
  private readonly lastContent = new Map<SurfaceRegion, readonly SceneLine[]>();
  private suspendedFlag = false;

  constructor(private readonly options: BlessedSurfaceOptions) {}

  get ready(): boolean {
    return this.screen !== null;
  }

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  get rows(): number {
    const rows = (this.options.program as unknown as { rows?: number }).rows;
    return typeof rows === 'number' ? rows : 24;
  }

  /**
   * Build every region now. Full-screen mode calls this from its constructor.
   *
   * Public rather than an implementation detail because "build eagerly" and
   * "build on demand" are different policies that belong to the caller, not to
   * the renderer: inline mode must not enter the alternate buffer until an
   * overlay asks for it.
   */
  attachAll(): void {
    this.createScreen(APPEND_ORDER);
  }

  /**
   * The screen, creating it with the overlay if this is the first draw, and
   * re-entering it if it is currently suspended.
   *
   * This is what an overlay in inline mode raises: the alternate buffer is
   * entered as a side effect of `blessed.screen`, which is why it cannot happen
   * eagerly there, but it has to exist by the time the overlay is painted.
   */
  ensure(): void {
    if (this.screen !== null) {
      if (this.suspendedFlag) {
        this.screen.enter();
        this.suspendedFlag = false;
        this.options.program.enableMouse();
      }
      return;
    }
    this.createScreen(OVERLAY_ONLY);
  }

  /**
   * Build the screen if it is missing, and do nothing else.
   *
   * Split from {@link ensure} because of one word: SUSPENDED. An update has to
   * be able to reach a region while the buffer is stepped aside, and if updates
   * re-entered the way `ensure` does, every single update would quietly undo the
   * suspension and repaint over the conversation underneath. Only the caller
   * knows whether it wants the buffer back.
   */
  private createIfMissing(): void {
    if (this.screen !== null) return;
    this.createScreen(OVERLAY_ONLY);
  }

  private createScreen(regions: readonly SurfaceRegion[]): void {
    if (this.screen !== null) return;
    const screen = blessed.screen(this.options.screenOptions) as ManagedScreen;
    const render = screen.render.bind(screen);
    screen.render = () => {
      // Blessed repaints on resize even after leave(). A suspended modal must
      // never paint its cached widgets over the normal conversation buffer.
      if (!this.suspendedFlag) render();
    };
    this.screen = screen;
    // Built here rather than in the constructor: `blessed.box()` needs an active
    // screen, and in inline mode there is none until this moment.
    for (const region of regions) {
      if (this.boxes.has(region)) continue;
      const box = blessed.box(regionSpec(this.options, region)) as Box;
      screen.append(box);
      this.boxes.set(region, box);
    }
  }

  update(region: SurfaceRegion, patch: RegionPatch): void {
    // Any draw implies there is something to draw on, so this creates the screen
    // on first use — but it must NOT re-enter a suspended one. See
    // `createIfMissing`.
    this.createIfMissing();
    const box = this.boxes.get(region);
    if (box === undefined) return;

    if (patch.lines !== undefined) {
      // blessed is the last leg that still speaks tags: it parses them itself,
      // so a span line has to be spelled back into that vocabulary here. Sending
      // it ANSI instead would print the escapes as literal text.
      box.setContent(patch.lines.map((line) => lineToTags(line)).join('\n'));
      this.lastContent.set(region, patch.lines);
    }
    if (patch.height !== undefined) box.height = patch.height;
    if (patch.bottom !== undefined) box.bottom = patch.bottom;
    // Border style BEFORE colour: swapping the border replaces the object the
    // colour lives on, so the other order silently drops it.
    if (patch.borderStyle !== undefined) {
      if (patch.borderStyle === 'none') Reflect.set(box, 'border', undefined);
      else Reflect.set(box, 'border', { type: 'line', left: false, right: false });
    }
    if (patch.borderColor !== undefined && box.style?.border !== undefined) {
      // The status region genuinely has no border, so a colour sent to it is
      // ignored rather than crashing. Guarded rather than enforced because the
      // caller cannot know which regions are framed, and that is the
      // renderer's business, not the paint method's.
      box.style.border.fg = patch.borderColor;
    }
    if (patch.hidden === true) {
      box.hide();
    } else if (patch.hidden === false && box.hidden) {
      box.show();
    }
  }

  /**
   * Report what blessed laid out.
   *
   * Read from the box rather than computed here, because `iwidth`/`iheight`
   * already account for whether a border is present — and the input box loses
   * its border on short terminals, which changes the answer by two in each
   * direction.
   *
   * The per-field fallbacks are not arbitrary: each one is the default the
   * caller used to pass to its own `asNumber` helper, and they are not
   * uniform. `innerLeft`/`innerTop` fall back to 1 because a borderless region
   * still indents its content by one column, while `left`/`top` are absolute
   * and default to 0. Smoothing these into one default would move the caret a
   * column on exactly the terminals where the border was dropped.
   */
  measure(region: SurfaceRegion): RegionMetrics | null {
    const box = this.boxes.get(region);
    if (box === undefined) return null;
    const measured = box as unknown as Record<string, unknown>;
    const number = (key: string, fallback: number): number =>
      typeof measured[key] === 'number' ? (measured[key] as number) : fallback;
    return {
      width: number('width', 0),
      innerWidth: number('iwidth', 2),
      height: number('height', 0),
      innerHeight: number('iheight', 2),
      left: number('left', 0),
      top: number('top', 0),
      innerLeft: number('ileft', 1),
      innerTop: number('itop', 1),
      laidOut: measured['lpos'] !== undefined,
    };
  }

  content(region: SurfaceRegion): readonly SceneLine[] {
    return this.lastContent.get(region) ?? [];
  }

  render(): void {
    this.screen?.render();
  }

  enter(): void {
    // The guard is "already entered", NOT "not suspended". Inverting it — the
    // shape `leave` uses — makes enter a no-op in exactly the one case it
    // exists for, which is the case where the buffer IS suspended.
    if (this.screen === null || !this.suspendedFlag) return;
    this.screen.enter();
    this.suspendedFlag = false;
    this.options.program.enableMouse();
  }

  leave(): void {
    if (this.screen === null || this.suspendedFlag) return;
    this.suspendedFlag = true;
    this.screen.leave();
    this.options.program.enableMouse();
  }

  destroy(): void {
    this.screen?.destroy();
    this.screen = null;
    this.boxes.clear();
    this.lastContent.clear();
    this.suspendedFlag = false;
  }
}

/**
 * electron/win32.ts — ElectronDesktopBackend (Windows, plan 454 §5 Task C).
 *
 * Concrete impl that drives the desktop via:
 *   - @nut-tree-fork/nut-js for mouse / keyboard / wheel
 *   - Electron desktopCapturer for screen capture (cross-platform via
 *     the Chromium stack — same API surface on macOS / Linux)
 *   - sharp for SOM overlay rendering
 *
 * All third-party access is injected through `ElectronDesktopBackendOptions`
 * so tests can mock without spinning up Electron. Production code uses
 * `createElectronDesktopBackend({ electron, sharp, nut })` which pulls
 * the live modules from the runtime.
 *
 * Platform detection: this file is named `win32.ts` but the body is
 * platform-agnostic — desktopCapturer + nut.js handle Mac / Linux
 * transparently. The platform-specific bits (focus_app, list_apps)
 * fall back to OSContextBridge.windowList when the native call doesn't
 * have a clean cross-platform equivalent.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';
import type {
  ActionResult,
  AppInfo,
  CaptureOptions,
  CaptureResult,
  ClickOptions,
  DesktopBackend,
  DragOptions,
  FocusAppOptions,
  KeyOptions,
  ScrollOptions,
  SetValueOptions,
  SomElement,
  TypeTextOptions,
} from '../types.js';
import type { Verdict } from '../../verdict/types.js';
import {
  buildClickVerdict,
  buildUnverifiableVerdict,
} from '../../verdict/builder.js';
import {
  decideClickInjection,
  applyInjectionToVerdict,
  type Win32NativeAdapter,
} from './win32-injection.js';

/**
 * Minimal subset of the `electron` module we depend on. The actual
 * import in production is the npm `electron` package, but we type
 * only the surface we touch so tests can supply a stub.
 */
export interface ElectronAdapter {
  desktopCapturer: {
    getSources(opts: {
      types: Array<'screen' | 'window'>;
      thumbnailSize?: { width: number; height: number };
      fetchWindowIcons?: boolean;
    }): Promise<
      Array<{
        id: string;
        name: string;
        display_id?: string;
        thumbnail: {
          toPNG(opts?: { scale?: number }): Promise<Buffer>;
          getSize(): { width: number; height: number };
        };
      }>
    >;
  };
}

/**
 * Minimal subset of `sharp` we use for SOM overlay rendering.
 * Tests inject a fake that records calls instead of doing real work.
 */
export interface SharpAdapter {
  (input: Buffer | string): SharpPipeline;
}

export interface SharpPipeline {
  /** Resize. Width/height in px. */
  resize(opts: { width?: number; height?: number; fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside' }): SharpPipeline;
  /** Extract a rectangular region (sharp.extract). left/top are pixel offsets into the source. */
  extract(region: { left: number; top: number; width: number; height: number }): SharpPipeline;
  /** Composite another image on top of this one. */
  composite(images: Array<{ input: Buffer; top?: number; left?: number }>): SharpPipeline;
  /** Encode to PNG. */
  png(opts?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> };
  /**
   * Image dimensions probe (sharp.metadata). Optional so test fakes can
   * omit it; the SOM overlay uses it to size the SVG to the actual
   * bitmap when the caller doesn't pass explicit dims.
   */
  metadata?(): Promise<{ width?: number; height?: number }>;
}

/**
 * Minimal subset of `@nut-tree-fork/nut-js` we depend on. The real
 * import exposes `mouse` / `keyboard` / `key` / `Point` / `Button`;
 * tests inject a recorder that captures the call sequence.
 */
export interface NutAdapter {
  mouse: {
    setPosition(point: { x: number; y: number }): Promise<void>;
    click(button?: 'LEFT' | 'RIGHT' | 'MIDDLE' | number): Promise<void>;
    /** Move + button-down + move + button-up. */
    drag?(from: Array<{ x: number; y: number }>): Promise<void>;
    /** Wheel scroll. amount is positive for down/right, negative for up/left. */
    wheel(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', amount: number): Promise<void>;
  };
  keyboard: {
    type(text: string, opts?: { delayMs?: number }): Promise<void>;
    pressKey(...keys: Array<string | number>): Promise<void>;
  };
  Key: Record<string, string | number>;
  Button: Record<'LEFT' | 'RIGHT' | 'MIDDLE', 'LEFT' | 'RIGHT' | 'MIDDLE' | number>;
}

/**
 * Options for `ElectronDesktopBackend`. Production wires the live
 * `electron` / `sharp` / `@nut-tree-fork/nut-js`; tests supply stubs.
 */
export interface ElectronDesktopBackendOptions {
  electron: ElectronAdapter;
  sharp: SharpAdapter;
  nut: NutAdapter;
  /**
   * Provider for SOM element detection. Defaults to an empty list
   * (no overlay); Phase 1 ships a heuristic detector in `../som/`.
   */
  detectElements?: (opts: { width: number; height: number }) => Promise<SomElement[]> | SomElement[];
  /**
   * Overlay renderer. Defaults to a no-op (returns the raw capture).
   * Phase 1 ships `drawSomOverlay` in `../som/overlay.ts`.
   * `dims` carries the capture thumbnail's real pixel size — the overlay
   * must not exceed the base image or sharp's composite() throws.
   */
  renderOverlay?: (
    image: Buffer,
    elements: SomElement[],
    dims?: { width: number; height: number },
  ) => Promise<Buffer>;
  /**
   * Provider for app list. Defaults to returning empty (the
   // OSContextBridge singleton is the production source).
   */
  listAppsProvider?: () => Promise<AppInfo[]> | AppInfo[];
  /**
   * Provider for focus-app. Defaults to no-op returning ok=false.
   * Production wires nut.js + native focus on Windows; macOS / Linux
   * may need platform-specific hooks.
   */
  focusAppProvider?: (opts: FocusAppOptions) => Promise<boolean>;
  /**
   * Provider for a post-action focused-entity read-back used to build a
   * Verdict (plan 519 §3.5 / A3). Production wires OSContextBridge's
   * latest `focusedEntity`. When absent, state-changing actions return
   * an `ActionResult` without a verdict (behavior unchanged).
   */
  readFocusedEntity?: () => Promise<FocusedEntity | null> | FocusedEntity | null;
  /**
   * Win32 native adapter for background-priority click injection
   * (plan 519 §3.7 / C1). When present, `click` resolves the window under
   * the target point and flags `fallbackUsed` on the verdict if the click
   * has to raise a different window. Absent → the normal cursor path runs
   * with no injection decision (behavior unchanged on non-Windows).
   */
  win32InputProvider?: Win32NativeAdapter | null;
  /**
   * Capture resolution in logical CSS pixels. Defaults to 1920x1080.
   * desktopCapturer returns native pixels; we resize down.
   */
  captureWidth?: number;
  captureHeight?: number;
}

/**
 * Platform-agnostic backend that delegates to Electron + nut.js.
 *
 * Threading: single-threaded Node.js. Methods are sequential and may
 * take hundreds of ms; Phase 2 callers should await before reading
 * follow-up capture results.
 */
export class ElectronDesktopBackend implements DesktopBackend {
  readonly id = 'electron';
  private readonly opts: Required<
    Pick<ElectronDesktopBackendOptions, 'captureWidth' | 'captureHeight'>
  > &
    ElectronDesktopBackendOptions;

  constructor(opts: ElectronDesktopBackendOptions) {
    this.opts = {
      captureWidth: opts.captureWidth ?? 1920,
      captureHeight: opts.captureHeight ?? 1080,
      ...opts,
    };
  }

  async capture(opts?: CaptureOptions): Promise<CaptureResult> {
    const start = Date.now();
    const somMode = opts?.somMode === true;
    const displayId = opts?.displayId ?? 0;
    const region = opts?.region;

    const sources = await this.opts.electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: this.opts.captureWidth,
        height: this.opts.captureHeight,
      },
    });

    // Pick the source matching the requested displayId. desktopCapturer
    // // exposes `display_id` as a string — fall back to the first source
    // if the lookup misses.
    let source = sources[displayId];
    if (!source) {
      source = sources[0];
    }
    if (!source) {
      // No screen available (CI / headless). Return a 1x1 transparent PNG
      // with empty element list so callers always get a valid shape.
      return {
        base64: '',
        width: 0,
        height: 0,
        elements: [],
        displayId,
        capturedAt: new Date().toISOString(),
      };
    }

    const nativeBuffer = await source.thumbnail.toPNG();
    const nativeSize = source.thumbnail.getSize();

    let elements: SomElement[] = [];
    let renderedBuffer = nativeBuffer;

    if (somMode) {
      if (this.opts.detectElements) {
        elements = await this.opts.detectElements({
          width: nativeSize.width,
          height: nativeSize.height,
        });
      }
      // When a region is set, only number elements that fall within
      // the rectangle AND crop the rendered image to that rectangle.
      // Before this change, zoom returned the full-screen capture
      // unchanged and only filtered which SOM numbers were drawn -
      // the model could see the overlay markers but could not
      // actually inspect the region at higher detail.
      if (region && (region.w ?? 0) > 0 && (region.h ?? 0) > 0) {
        if (elements.length > 0) {
          elements = elements.filter(
            (el) =>
              el.bbox.x + el.bbox.w >= region.x &&
              el.bbox.x <= region.x + region.w &&
              el.bbox.y + el.bbox.h >= region.y &&
              el.bbox.y <= region.y + region.h,
          );
        }
      }
      if (this.opts.renderOverlay && elements.length > 0) {
        renderedBuffer = await this.opts.renderOverlay(nativeBuffer, elements, {
          width: nativeSize.width,
          height: nativeSize.height,
        });
      }
    }

    // Crop the final buffer to the requested region. Element bbox
    // coordinates are re-based so SOM numbers refer to the cropped
    // image, which matches the bboxes the capture pipeline emits
    // for full-screen captures.
    if (region && (region.w ?? 0) > 0 && (region.h ?? 0) > 0) {
      const safeW = Math.min(region.w, nativeSize.width - region.x);
      const safeH = Math.min(region.h, nativeSize.height - region.y);
      if (safeW > 0 && safeH > 0) {
        const cropped = await this.opts.sharp(renderedBuffer)
          .extract({
            left: Math.max(0, region.x),
            top: Math.max(0, region.y),
            width: safeW,
            height: safeH,
          })
          .png()
          .toBuffer();
        renderedBuffer = cropped;
        const dx = -Math.max(0, region.x);
        const dy = -Math.max(0, region.y);
        elements = elements.map((el) => ({
          ...el,
          bbox: {
            x: el.bbox.x + dx,
            y: el.bbox.y + dy,
            w: el.bbox.w,
            h: el.bbox.h,
          },
        }));
        return {
          base64: renderedBuffer.toString('base64'),
          width: safeW,
          height: safeH,
          elements,
          displayId,
          capturedAt: new Date().toISOString(),
        };
      }
    }

    return {
      base64: renderedBuffer.toString('base64'),
      width: nativeSize.width,
      height: nativeSize.height,
      elements,
      displayId,
      capturedAt: new Date().toISOString(),
    };
    // `start` reserved for future telemetry (capture duration).
    void start;
  }

  async click(opts: ClickOptions): Promise<ActionResult> {
    const start = Date.now();
    try {
      const point = await this.resolveClickPoint(opts);
      if (!point) {
        return {
          ok: false,
          reason: 'click: could not resolve target (no element and no coords)',
          durationMs: Date.now() - start,
        };
      }
      const before = this.canReadback() ? await this.peekFocusedEntity() : null;
      await this.opts.nut.mouse.setPosition(point);
      const button = this.toNutButton(opts.button ?? 'left');
      const count = opts.count ?? 'single';
      // Inter-click delay matching OS conventions (~10ms). For
      // double/triple click, the OS uses a small delay between
      // presses so the multi-click registers as a single gesture.
      const interClickDelayMs = 10;
      const totalClicks = count === 'single' ? 1 : count === 'double' ? 2 : 3;
      for (let i = 0; i < totalClicks; i++) {
        await this.opts.nut.mouse.click(button);
        if (i < totalClicks - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, interClickDelayMs));
        }
      }
      let verdict =
        this.canReadback() && this.opts.readFocusedEntity
          ? await this.mouseReadback(before)
          : undefined;
      // plan 519 §3.7 / C1: when a Win32 native adapter is wired, check
      // whether the target window differs from the foreground. A fallback
      // to raise (or a missing target) must be surfaced on the verdict so
      // the model knows the click may have moved focus.
      if (this.opts.win32InputProvider && verdict) {
        const decision = decideClickInjection({
          foreground: this.opts.win32InputProvider.getForegroundWindow(),
          target: this.opts.win32InputProvider.windowFromPoint(point.x, point.y),
        });
        applyInjectionToVerdict(verdict, decision);
      }
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async drag(opts: DragOptions): Promise<ActionResult> {
    const start = Date.now();
    try {
      // Element refs are not yet supported by drag (Phase 1) — the
      // tool layer is expected to resolve them to coords upstream.
      if (opts.fromX === undefined || opts.fromY === undefined || opts.toX === undefined || opts.toY === undefined) {
        return {
          ok: false,
          reason: 'drag: explicit coords required in Phase 1 (element refs not supported)',
          durationMs: Date.now() - start,
        };
      }
      const steps = Math.max(1, opts.steps ?? 10);
      const path: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        path.push({
          x: Math.round(opts.fromX + (opts.toX - opts.fromX) * t),
          y: Math.round(opts.fromY + (opts.toY - opts.fromY) * t),
        });
      }
      const before = this.canReadback() ? await this.peekFocusedEntity() : null;
      // nut.js drag expects a path; fall back to setPosition sequence
      // if drag isn't available.
      if (this.opts.nut.mouse.drag) {
        await this.opts.nut.mouse.drag(path);
      } else {
        for (const p of path) {
          await this.opts.nut.mouse.setPosition(p);
        }
      }
      const verdict =
        this.canReadback() && this.opts.readFocusedEntity
          ? await this.mouseReadback(before)
          : undefined;
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async scroll(opts: ScrollOptions): Promise<ActionResult> {
    const start = Date.now();
    try {
      const dir = this.toNutDirection(opts.direction);
      await this.opts.nut.mouse.wheel(dir, opts.amount);
      const verdict = this.canReadback() ? await this.textReadback() : undefined;
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async typeText(opts: TypeTextOptions): Promise<ActionResult> {
    const start = Date.now();
    try {
      await this.opts.nut.keyboard.type(opts.text, { delayMs: opts.delayMs ?? 10 });
      const verdict = this.canReadback() ? await this.textReadback() : undefined;
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async key(opts: KeyOptions): Promise<ActionResult> {
    const start = Date.now();
    try {
      const keys = [opts.key, ...(opts.modifiers ?? [])];
      // nut.js expects each key as a separate argument.
      const resolved: Array<string | number> = [];
      for (const k of keys) {
        resolved.push(this.toNutKey(k));
      }
      await this.opts.nut.keyboard.pressKey(...resolved);
      const verdict = this.canReadback() ? await this.textReadback() : undefined;
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async listApps(): Promise<AppInfo[]> {
    if (this.opts.listAppsProvider) {
      return this.opts.listAppsProvider();
    }
    return [];
  }

  async focusApp(opts: FocusAppOptions): Promise<ActionResult> {
    if (!this.opts.focusAppProvider) {
      return { ok: false, reason: 'focusApp: no provider configured' };
    }
    const start = Date.now();
    try {
      // plan 519 §3.7 / C2: `raise` defaults to false (background
      // priority) — never resurrect a foreground-stealing default. Pass
      // the explicit value through so the provider can branch.
      const resolved: FocusAppOptions = { ...opts, raise: opts.raise ?? false };
      const ok = await this.opts.focusAppProvider(resolved);
      return {
        ok,
        reason: ok ? undefined : 'focusApp: provider returned false',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async setValue(opts: SetValueOptions): Promise<ActionResult> {
    // Cross-platform: select-all (Ctrl+A / Cmd+A) + type. Phase 1 keeps
    // it simple — Phase 3 may add UIA-aware direct-set on Windows.
    const start = Date.now();
    try {
      const selectAllModifier = process.platform === 'darwin' ? 'meta' : 'ctrl';
      await this.key({
        key: 'A',
        modifiers: [selectAllModifier],
      });
      await this.opts.nut.keyboard.type(opts.value, { delayMs: opts.delayMs ?? 10 });
      const verdict = this.canReadback() ? await this.textReadback() : undefined;
      return { ok: true, durationMs: Date.now() - start, verdict };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async wait(opts: { ms: number }): Promise<void> {
    const ms = Math.max(0, opts.ms);
    if (ms === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  // ────────────────────────────────────────────────────────────────────
  // Verdict read-back helpers (plan 519 §3.5 / A3)
  // ────────────────────────────────────────────────────────────────────

  /** Whether a post-action read-back provider is wired. */
  private canReadback(): boolean {
    return typeof this.opts.readFocusedEntity === 'function';
  }

  /** One focused-entity snapshot via the injected provider (never throws). */
  private async peekFocusedEntity(): Promise<FocusedEntity | null> {
    if (!this.opts.readFocusedEntity) return null;
    try {
      return await Promise.resolve(this.opts.readFocusedEntity());
    } catch {
      return null;
    }
  }

  /**
   * Read-back + verdict for mouse ops (click / drag): compare focus
   * captured before the action with the post-action snapshot.
   */
  private async mouseReadback(
    before: FocusedEntity | null,
  ): Promise<Verdict | undefined> {
    const readStart = Date.now();
    const after = await this.peekFocusedEntity();
    return buildClickVerdict(before, after, {
      readbackMs: Date.now() - readStart,
    });
  }

  /**
   * Read-back + verdict for keyboard / text ops (type / key / set_value /
   * scroll). A keystroke into the focused field never changes
   * `FocusedEntity`, so we report an honest `unverifiable` rather than a
   * false `suspected_noop`.
   */
  private async textReadback(): Promise<Verdict | undefined> {
    const readStart = Date.now();
    const after = await this.peekFocusedEntity();
    return buildUnverifiableVerdict(after, {
      readbackMs: Date.now() - readStart,
    });
  }

  /**
   * Resolve a click target to a screen point. Prefers SOM element
   * refs; falls back to explicit coords.
   */
  private async resolveClickPoint(opts: ClickOptions): Promise<{ x: number; y: number } | null> {
    if (opts.element !== undefined) {
      // Phase 1 doesn't carry element-bbox mapping through click;
      // tool layer is expected to resolve element → coords upstream
      // and pass x/y. If the tool layer forgot to do that, we try
      // to look up the element via a capture-then-extract round trip.
      // For now, we surface a structured failure so callers can fix.
      return null;
    }
    if (opts.x !== undefined && opts.y !== undefined) {
      return { x: opts.x, y: opts.y };
    }
    return null;
  }

  private toNutButton(button: 'left' | 'right' | 'middle'): number {
    // nut.js's MouseAction.buttonLookup(btn) expects the numeric value
    // from the @nut-tree-fork/shared Button enum (LEFT=0, MIDDLE=1,
    // RIGHT=2). Returning the string name here caused libnut's native
    // mouseClick to throw "A string was expected" because Map.get on the
    // numeric-keyed ButtonLookupMap returned undefined.
    const upper = button.toUpperCase() as 'LEFT' | 'RIGHT' | 'MIDDLE';
    const map = this.opts.nut.Button;
    if (map && typeof map === 'object' && typeof map[upper] === 'number') {
      return map[upper] as number;
    }
    // Fallback: numeric enum positions are LEFT=0, MIDDLE=1, RIGHT=2.
    return upper === 'RIGHT' ? 2 : upper === 'MIDDLE' ? 1 : 0;
  }

  private toNutDirection(direction: 'up' | 'down' | 'left' | 'right'): 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' {
    return direction.toUpperCase() as 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  }

  private toNutKey(name: string): string | number {
    const map = this.opts.nut.Key;
    if (map && typeof map === 'object' && name in map) {
      const v = map[name];
      if (typeof v === 'string' || typeof v === 'number') return v;
    }
    return name;
  }
}
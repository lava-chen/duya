/**
 * types.ts — DesktopBackend interface (plan 454 §5 Task B).
 *
 * Platform-agnostic surface that any DesktopBackend implementation must
 * satisfy. Phase 1 ships two impls:
 *   - `NoopDesktopBackend`  (default in tests / when nut.js disabled)
 *   - `ElectronDesktopBackend` (nut.js + Electron desktopCapturer + sharp)
 *
 * The interface is intentionally narrow: capture / click / drag / scroll /
 * type / key / listApps / focusApp / setValue / wait. Higher-level
 * coordination lives in packages/agent/src/tool/OSTool/ (Phase 2).
 *
 * No osascript / xdotool / PowerShell leaks here. Cross-platform parity
 * is the whole point of going through nut.js.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';
import type { Verdict } from '../verdict/types.js';

/**
 * Captured screen with optional SOM (Set-of-Mark) overlay.
 *
 * `base64` is the rendered PNG (with SOM overlay drawn if requested).
 * `elements` is populated only when `somMode: true` — empty otherwise.
 */
export interface CaptureResult {
  /** PNG bytes encoded as base64. Empty when capture failed. */
  base64: string;
  /** Logical width of the captured screen in CSS pixels. */
  width: number;
  /** Logical height of the captured screen in CSS pixels. */
  height: number;
  /**
   * Set-of-Mark element index → boundary. Populated only when
   * `capture({ somMode: true })`. Index is 1-based for LLM consumption.
   */
  elements: SomElement[];
  /** Display index the capture came from. */
  displayId: number;
  /** ISO timestamp when the capture was taken. */
  capturedAt: string;
}

/**
 * Axis-aligned bounding box in screen coordinates (logical pixels,
 * top-left origin). Used for SOM element regions and for
 * `zoom`-style region-restricted captures.
 */
export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SomElement {
  /**
   * 1-based index. The LLM says "click element 5" and the tool
   * computes bbox center.
   */
  index: number;
  /** Bounding box in screen coordinates (logical pixels). */
  bbox: Bbox;
  /** Short label rendered next to the bbox in the overlay. */
  label: string;
  /**
   * Heuristic category — drives click behavior (e.g. an Edit may
   * require focus before typing). Optional because heuristic detection
   * is best-effort.
   */
  kind?:
    | 'Button'
    | 'Input'
    | 'Text'
    | 'Image'
    | 'Edit'
    | 'Document'
    | 'ComboBox'
    | 'Tab'
    | 'Unknown';
  /**
   * Where this element's metadata came from (plan 519 §3.4). Lets the
   * model judge the reliability of the label: tree-enumerated and
   * UIA/MSAA elements carry a real `name`/`controlType` (tree sources
   * also carry real coordinates — plan 562 Phase 2); focused-entity
   * and heuristic are best-effort.
   */
  axSource?: 'uia-tree' | 'ax-tree' | 'uia' | 'msaa' | 'focused-entity' | 'heuristic';
}

/**
 * Capture options.
 *
 * - `somMode`: when true, the implementation must render element
 *   index overlays. Phase 1 uses heuristic detection (focusedEntity +
 *   primary-button contrast).
 * - `displayId`: when set, target a specific display; defaults to the
 *   primary (0).
 * - `region`: when set, restrict the SOM element detection to the
 *   given rectangle. The capture itself is still the full screen;
 *   the region only narrows which elements get numbered. Combined
 *   with the agent's `zoom` action this lets the model inspect
 *   small UI areas without losing the full-screen context.
 */
export interface CaptureOptions {
  somMode?: boolean;
  displayId?: number;
  region?: Bbox;
}

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Click count. `single` is the default (one click). `double` and
 * `triple` are used for double-click / triple-click on selectable
 * text and list items. The backend dispatches the appropriate
 * number of `mouse.click` events with a short inter-click delay
 * (typically ~10ms, matching OS conventions).
 */
export type ClickCount = 'single' | 'double' | 'triple';

/**
 * Click options. Prefer `element` (SOM index) over raw coordinates —
 * the model has a much higher hit rate when it can reference a labeled
 * bbox than when it has to guess pixel offsets.
 *
 * Coordinates are logical pixels (same coord system as `CaptureResult`).
 */
export interface ClickOptions {
  /** SOM element index (preferred). The backend resolves it to bbox center. */
  element?: number;
  /** Fallback: explicit x coordinate. Used only when `element` is absent. */
  x?: number;
  /** Fallback: explicit y coordinate. Used only when `element` is absent. */
  y?: number;
  /** Mouse button. Defaults to 'left'. */
  button?: MouseButton;
  /** Click count. Defaults to 'single'. 'double' and 'triple' fire 2/3 clicks. */
  count?: ClickCount;
  /** Modifier keys held during the click (nut.js Key enum values). */
  modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
}

/**
 * Drag options. Symmetric with click: prefer element refs over coords.
 *
 * `steps` controls how many intermediate mouse positions nut.js
 * interpolates through. Higher = smoother + slower. Defaults to 10.
 */
export interface DragOptions {
  fromElement?: number;
  toElement?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  steps?: number;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface ScrollOptions {
  direction: ScrollDirection;
  /** Number of wheel ticks. Each tick ≈ 100px on most platforms. */
  amount: number;
}

export interface TypeTextOptions {
  /** Plain text to type. Newlines are honored as Enter presses. */
  text: string;
  /** Delay between keystrokes in ms. Defaults to 10ms. */
  delayMs?: number;
}

export interface KeyOptions {
  /** Key name — nut.js Key enum value (e.g. 'Enter', 'Escape', 'Tab'). */
  key: string;
  modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
}

export interface AppInfo {
  /** Window title (focused window if not specified otherwise). */
  title: string;
  /** OS process name (e.g. 'chrome.exe', 'Code.exe'). */
  processName: string;
  /** Window PID. May be null if the platform can't resolve it cheaply. */
  pid: number | null;
  /**
   * Current focused entity — mirrors OSContextBridge.focusedEntity.
   * Backends that can't read this should return null and let the caller
   * fall back to the OSContextBridge singleton.
   */
  focusedEntity?: FocusedEntity | null;
}

export interface FocusAppOptions {
  /** Window title substring (case-insensitive). */
  title?: string;
  /** Process name (case-insensitive). */
  processName?: string;
  /**
   * Whether to raise + activate the window to the foreground. Default
   * `false` (plan 519 §3.7 / C2, background priority): focus the target
   * window without stealing the user's foreground when possible. Set
   * `true` to force a foreground activation.
   */
  raise?: boolean;
}

export interface SetValueOptions {
  /** Text to set into the focused field. Equivalent to clear-then-type. */
  value: string;
  /** Delay between keystrokes in ms. Defaults to 10ms. */
  delayMs?: number;
}

/**
 * Result returned by `click` / `drag` / `scroll`. Backends may
 * populate timing data; consumers should treat it as advisory.
 */
export interface ActionResult {
  ok: boolean;
  /** When ok=false, a short reason for telemetry. */
  reason?: string;
  /** Approximate duration in ms (best-effort). */
  durationMs?: number;
  /**
   * Structured read-back verdict for state-changing actions
   * (plan 519 §3.5). Present after click / drag / type / key / set_value
   * when a read-back provider is configured. Lets the model react rather
   * than guess whether the action took effect.
   */
  verdict?: Verdict;
}

/**
 * The core interface every DesktopBackend must satisfy.
 *
 * Design contract:
 *  - All methods are async and may reject; never throw synchronously
 *    (let the tool layer wrap in ToolResult).
 *  - Coordinate system: logical CSS pixels, top-left origin.
 *  - Element indices are 1-based and per-capture (a new capture
 *    invalidates old indices).
 */
export interface DesktopBackend {
  /**
   * Capture the screen (optionally with SOM overlay rendered on top).
   * The returned `base64` is the rendered image; consumers can embed
   * it in tool results as an image content block.
   */
  capture(opts?: CaptureOptions): Promise<CaptureResult>;

  /**
   * Click at an SOM element index or explicit coordinates.
   * `element` is preferred; `x`/`y` are fallbacks when SOM is off.
   */
  click(opts: ClickOptions): Promise<ActionResult>;

  /** Drag from one element/coord to another. */
  drag(opts: DragOptions): Promise<ActionResult>;

  /** Scroll the wheel in a given direction. */
  scroll(opts: ScrollOptions): Promise<ActionResult>;

  /** Type text into the currently focused field. */
  typeText(opts: TypeTextOptions): Promise<ActionResult>;

  /** Press a key (with optional modifiers). */
  key(opts: KeyOptions): Promise<ActionResult>;

  /**
   * List visible apps. Phase 1: best-effort, may fall back to
   * OSContextBridge.windowList if the platform backend doesn't track
   * windows natively.
   */
  listApps(): Promise<AppInfo[]>;

  /** Focus (raise + activate) an app window. */
  focusApp(opts: FocusAppOptions): Promise<ActionResult>;

  /**
   * Replace the value of the currently focused field. Implemented as
   * select-all + type for cross-platform parity.
   */
  setValue(opts: SetValueOptions): Promise<ActionResult>;

  /** Sleep for `ms` milliseconds. Exposed as an action for pacing. */
  wait(opts: { ms: number }): Promise<void>;

  /**
   * Identifier of the backend (e.g. `'noop'`, `'electron-win32'`).
   * Useful for telemetry + approval UI rendering.
   */
  readonly id: string;
}
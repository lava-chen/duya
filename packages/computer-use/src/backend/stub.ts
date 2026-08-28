/**
 * stub.ts — NoopDesktopBackend (plan 454 §5 Task B).
 *
 * Returns deterministic, harmless outputs. Used by:
 *   - Tests that exercise the tool layer without a real desktop.
 *   - The default backend when computer-use mode is disabled.
 *   - CI / headless environments where nut.js cannot load.
 *
 * Crucially, `typeText` and `key` record what would have been typed
 * into a `recordedActions` array so tests can assert call sequences
 * without ever moving the mouse.
 */

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
  TypeTextOptions,
} from './types.js';

/**
 * One recorded action. Tests can read `getRecordedActions()` and
 * assert against the timeline.
 */
export interface RecordedAction {
  /** ISO timestamp. */
  at: string;
  /** Method name (e.g. 'click', 'typeText'). */
  method: string;
  /** Method arguments, deep-cloned so later mutations don't leak. */
  args: unknown;
}

/**
 * Options for NoopDesktopBackend. Phase 1 keeps them minimal; later
 * phases may add `captureFactory` for screenshot fixtures.
 */
export interface NoopDesktopBackendOptions {
  /**
   * Pre-baked capture result to return from `capture()`. When unset,
   * a tiny 1x1 transparent PNG is returned so consumers always get a
   * valid (if useless) image.
   */
  defaultCapture?: CaptureResult;
  /**
   * Pre-baked app list to return from `listApps()`. Defaults to a
   * single dummy app with no focused entity.
   */
  defaultApps?: AppInfo[];
  /**
   * When true, `click` / `drag` / `scroll` return ok=false with a
   * descriptive reason. Useful for tests that exercise the safety /
   * approval path.
   */
  rejectActions?: boolean;
}

const TINY_PNG_BASE64 =
  // 1x1 transparent PNG
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Default capture used when no fixture is provided.
 */
function defaultCapture(): CaptureResult {
  return {
    base64: TINY_PNG_BASE64,
    width: 1,
    height: 1,
    elements: [],
    displayId: 0,
    capturedAt: new Date(0).toISOString(),
  };
}

/**
 * Default app list used when no fixture is provided.
 */
function defaultApps(): AppInfo[] {
  return [
    {
      title: 'Noop',
      processName: 'noop',
      pid: 0,
      focusedEntity: null,
    },
  ];
}

/**
 * No-op backend. All actions succeed (or all reject when configured),
 * capture returns a tiny PNG, listApps returns a single dummy entry.
 */
export class NoopDesktopBackend implements DesktopBackend {
  readonly id = 'noop';
  private readonly opts: NoopDesktopBackendOptions;
  private readonly actions: RecordedAction[] = [];

  constructor(opts: NoopDesktopBackendOptions = {}) {
    this.opts = {
      defaultCapture: opts.defaultCapture,
      defaultApps: opts.defaultApps,
      rejectActions: opts.rejectActions,
    };
  }

  async capture(opts?: CaptureOptions): Promise<CaptureResult> {
    this.record('capture', opts ?? {});
    return this.opts.defaultCapture ?? defaultCapture();
  }

  async click(opts: ClickOptions): Promise<ActionResult> {
    this.record('click', opts);
    return this.actionResult('click');
  }

  async drag(opts: DragOptions): Promise<ActionResult> {
    this.record('drag', opts);
    return this.actionResult('drag');
  }

  async scroll(opts: ScrollOptions): Promise<ActionResult> {
    this.record('scroll', opts);
    return this.actionResult('scroll');
  }

  async typeText(opts: TypeTextOptions): Promise<ActionResult> {
    this.record('typeText', opts);
    return this.actionResult('typeText');
  }

  async key(opts: KeyOptions): Promise<ActionResult> {
    this.record('key', opts);
    return this.actionResult('key');
  }

  async listApps(): Promise<AppInfo[]> {
    this.record('listApps', {});
    // Return a fresh array so callers can't mutate the cached one.
    return this.opts.defaultApps
      ? this.opts.defaultApps.map((a) => ({ ...a }))
      : defaultApps();
  }

  async focusApp(opts: FocusAppOptions): Promise<ActionResult> {
    this.record('focusApp', opts);
    return this.actionResult('focusApp');
  }

  async setValue(opts: SetValueOptions): Promise<ActionResult> {
    this.record('setValue', opts);
    return this.actionResult('setValue');
  }

  async wait(opts: { ms: number }): Promise<void> {
    this.record('wait', opts);
    // Honor the requested delay even in tests — keeps tests honest
    // about how real impls will behave.
    const ms = Math.max(0, opts.ms);
    if (ms === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Read-only snapshot of recorded actions. */
  getRecordedActions(): readonly RecordedAction[] {
    return [...this.actions];
  }

  /** Reset recorded actions (useful between test cases). */
  clearRecordedActions(): void {
    this.actions.length = 0;
  }

  private actionResult(method: string): ActionResult {
    if (this.opts.rejectActions) {
      return { ok: false, reason: `${method}: stub rejects actions` };
    }
    return { ok: true, durationMs: 0 };
  }

  private record(method: string, args: unknown): void {
    this.actions.push({
      at: new Date().toISOString(),
      method,
      args: structuredClone(args),
    });
  }
}
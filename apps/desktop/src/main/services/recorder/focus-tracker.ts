/**
 * services/recorder/focus-tracker.ts — foreground window polling
 * (plan 556 Phase 1).
 *
 * Polls the foreground window every 500ms via PowerShell (single-window
 * query in computer-use-backend.ts, same pattern as the other user32
 * P/Invoke helpers) and reports CHANGES only: hwnd, or pid, or title
 * moving triggers `onChange(prev, next)` — the recorder-service turns
 * that into an `app_focus` RecorderEvent and a typing-buffer flush.
 *
 * The tracker never interprets events and holds no buffers; a failed
 * query keeps the previous snapshot (PowerShell hiccups must not spam
 * focus changes).
 */

import { getForegroundWindowInfo, type ForegroundWindowInfo } from '../computer-use-backend.js';
import { getLogger, LogComponent } from '../../logging/logger.js';

const logger = getLogger();

/** Default poll cadence (design §4.3). */
export const FOCUS_POLL_INTERVAL_MS = 500;

export type FocusQuery = () => Promise<ForegroundWindowInfo | null>;

export interface RecorderFocusTrackerOptions {
  intervalMs?: number;
  /** Injectable query (tests); defaults to the PowerShell probe. */
  query?: FocusQuery;
  onChange: (prev: ForegroundWindowInfo | null, next: ForegroundWindowInfo) => void;
}

export class RecorderFocusTracker {
  private timer: NodeJS.Timeout | null = null;
  private current: ForegroundWindowInfo | null = null;
  private polling = false;
  private disposed = false;
  private readonly opts: { intervalMs: number; query: FocusQuery; onChange: RecorderFocusTrackerOptions['onChange'] };

  constructor(opts: RecorderFocusTrackerOptions) {
    this.opts = {
      intervalMs: opts.intervalMs ?? FOCUS_POLL_INTERVAL_MS,
      query: opts.query ?? getForegroundWindowInfo,
      onChange: opts.onChange,
    };
  }

  get snapshot(): ForegroundWindowInfo | null {
    return this.current;
  }

  /** Start polling; runs one immediate query so the first user input
   * already has an app snapshot. */
  start(): void {
    if (this.timer) return;
    this.disposed = false;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const next = await this.opts.query();
      if (this.disposed) return;
      if (!next) {
        return; // query hiccup: keep previous snapshot
      }
      const prev = this.current;
      const changed =
        prev === null ||
        prev.hwnd !== next.hwnd ||
        prev.pid !== next.pid ||
        prev.title !== next.title;
      this.current = next;
      if (changed) {
        this.opts.onChange(prev, next);
      }
    } catch (err) {
      logger.debug(
        'recorder focus poll failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.ComputerUse,
      );
    } finally {
      this.polling = false;
    }
  }
}

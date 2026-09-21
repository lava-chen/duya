/**
 * aggregators.ts — raw hook events → RecorderEvents (plan 556 Phase 1).
 *
 * Pure state machines; no I/O, no clocks of their own. Every decision is
 * driven by the `ts` stamped on incoming worker lines (or injected
 * `now()` for poll sweeps), which is what makes the whole layer
 * unit-testable without fake timers.
 *
 * Three machines share one buffer-flush discipline:
 *
 *  - Keyboard: idle → typing → flush. Text accumulates printable chars
 *    (`<key:N>` placeholders for unmapped printables, D6); flushed by
 *    focus change / click / 2s silence / combo key / named key.
 *  - Wheel: 500ms same-direction debounce; opposite direction or a
 *    longer gap flushes and starts a new run.
 *  - Click: mousedown+mouseup pairs collapse into one `click` event;
 *    libuiohook's `clicks` field (OS double-click tracking) maps to
 *    count 1|2, anything ≥3 clamps to 2. Extra buttons (4/5) are dropped.
 *
 * Combos need no separate modifier FSM: uiohook stamps the modifier
 * flags onto every keydown at hook time, so "ctrl/alt/meta held while a
 * non-modifier goes down" is readable straight off the event. Shift
 * alone is not a combo (shift+h is text "H").
 *
 * The aggregator never decides element descriptors — it stamps
 * `{ source: 'none' }` and the recorder-service enriches click/type
 * events with the UIA probe result before the store append. The password
 * hint (`ctx.redact`) is owned by the service: it flips on when a probe
 * saw IsPassword and stays until the next click/app change; the
 * store-level `redactRecorderEvent` is the second line of defence.
 */

import type { AppRef, ElementDescriptor, RecorderEvent } from './events.js';
import { REDACTED_TEXT } from './privacy.js';
import { MODIFIER_KEYCODES } from './keymap.js';
import {
  isComboKeyDown,
  type KeyDownEvent,
  type MouseDownEvent,
  type MouseUpEvent,
  type WheelEvent,
  type WorkerEvent,
} from './worker-protocol.js';

/** Defaults from the design doc §4.2. */
export const TYPE_SILENCE_FLUSH_MS = 2_000;
export const WHEEL_DEBOUNCE_MS = 500;

export const NO_ELEMENT: ElementDescriptor = { source: 'none' };

/** App snapshot + password hint carried alongside each worker event. */
export interface FeedContext {
  app: AppRef;
  /**
   * True while keystrokes should be redacted at flush (the last probed
   * element under the cursor was a password field). The service resets
   * this on the next click / app change.
   */
  redact?: boolean;
}

export interface AggregatorOptions {
  now?: () => number;
  typeSilenceFlushMs?: number;
  wheelDebounceMs?: number;
}

interface BufferedKeystroke {
  text: string;
  ts: number;
}

interface PendingWheel {
  direction: 'up' | 'down';
  amount: number;
  firstTs: number;
  lastTs: number;
}

interface PendingClick {
  x: number;
  y: number;
  button: MouseDownEvent['button'];
  clicks: number;
  ts: number;
}

/**
 * The one-stop aggregator. Feed worker lines + focus changes in; collect
 * the RecorderEvents that come out (callers append them in order).
 */
export class RecorderAggregator {
  private readonly opts: Required<AggregatorOptions>;

  private typed: BufferedKeystroke[] = [];
  private lastTypeTs = 0;

  private pendingWheel: PendingWheel | null = null;
  private pendingClick: PendingClick | null = null;

  constructor(opts: AggregatorOptions = {}) {
    this.opts = {
      now: opts.now ?? (() => Date.now()),
      typeSilenceFlushMs: opts.typeSilenceFlushMs ?? TYPE_SILENCE_FLUSH_MS,
      wheelDebounceMs: opts.wheelDebounceMs ?? WHEEL_DEBOUNCE_MS,
    };
  }

  /**
   * Feed one validated worker line. `app` is the foreground app snapshot
   * at (or nearest before) the event's timestamp. Returns the events
   * that became ready, in order.
   */
  feed(event: WorkerEvent, ctx: FeedContext): RecorderEvent[] {
    // Lazy silence flush: a type buffer that went quiet long before this
    // event belongs to the earlier moment; flush it first so ordering
    // stays truthful.
    const out = this.flushTypeIfSilent(event.ts, ctx);

    switch (event.kind) {
      case 'keydown':
        out.push(...this.feedKeyDown(event, ctx));
        break;
      case 'keyup':
        break; // Modifier flags ride on keydown events; keyup carries nothing.
      case 'mousedown':
        this.pendingClick = {
          x: event.x,
          y: event.y,
          button: event.button,
          clicks: event.clicks,
          ts: event.ts,
        };
        break;
      case 'mouseup':
        out.push(...this.feedMouseUp(event, ctx));
        break;
      case 'wheel':
        out.push(...this.feedWheel(event, ctx));
        break;
      case 'heartbeat':
        break;
    }
    return out;
  }

  /**
   * Foreground app changed: flush everything buffered — typing and
   * scrolling belong to the OLD app, so the caller passes the previous
   * snapshot as the flush app.
   */
  onAppChanged(prevApp: AppRef, ctx: FeedContext): RecorderEvent[] {
    return this.flushAll(prevApp, ctx);
  }

  /**
   * Periodic sweep (service calls ~1/s) so silence flushes surface even
   * when no further event arrives. `nowTs` overrides the injected clock
   * for this sweep (tests drive it directly).
   */
  poll(ctx: FeedContext, nowTs?: number): RecorderEvent[] {
    const now = nowTs ?? this.opts.now();
    const out = this.flushTypeIfSilent(now, ctx);
    if (this.pendingWheel && now - this.pendingWheel.lastTs >= this.opts.wheelDebounceMs) {
      out.push(this.emitWheel(this.pendingWheel, ctx));
      this.pendingWheel = null;
    }
    return out;
  }

  /** Final flush at recording stop. */
  finish(ctx: FeedContext): RecorderEvent[] {
    return this.flushAll(ctx.app, ctx);
  }

  /** Drop all buffers (used when a worker restart invalidates mid-state). */
  reset(): void {
    this.typed = [];
    this.lastTypeTs = 0;
    this.pendingWheel = null;
    this.pendingClick = null;
  }

  // --- keyboard ---------------------------------------------------------

  private feedKeyDown(event: KeyDownEvent, ctx: FeedContext): RecorderEvent[] {
    // Modifier presses carry no text and no combo by themselves.
    if (MODIFIER_KEYCODES.has(event.keycode)) {
      return [];
    }
    // Combos first: ctrl/alt/meta held → standalone key event, flush text.
    if (isComboKeyDown(event)) {
      const flush = this.flushType(ctx);
      const keyEvent: RecorderEvent = {
        type: 'key',
        ts: event.ts,
        app: ctx.app,
        key: this.comboKeyName(event),
        modifiers: this.currentModifiers(event),
      };
      return [...flush, keyEvent];
    }
    // Named keys (enter/tab/escape/…): standalone key event + flush.
    if (event.name !== null && event.char === null) {
      const flush = this.flushType(ctx);
      const keyEvent: RecorderEvent = {
        type: 'key',
        ts: event.ts,
        app: ctx.app,
        key: event.name,
        modifiers: this.currentModifiers(event),
      };
      return [...flush, keyEvent];
    }
    // Plain printable, or unmapped printable → D6 placeholder.
    const piece = event.char ?? (event.name === null ? `<key:${event.keycode}>` : null);
    if (piece === null) {
      return [];
    }
    this.typed.push({ text: piece, ts: event.ts });
    this.lastTypeTs = event.ts;
    return [];
  }

  private comboKeyName(event: KeyDownEvent): string {
    if (event.name !== null) {
      return event.name;
    }
    if (event.char !== null && event.char.length === 1) {
      return event.char.toLowerCase();
    }
    return `<key:${event.keycode}>`;
  }

  private currentModifiers(event: KeyDownEvent): string[] {
    const mods: string[] = [];
    if (event.ctrlKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.metaKey) mods.push('meta');
    if (event.shiftKey) mods.push('shift');
    return mods;
  }

  private flushTypeIfSilent(atTs: number, ctx: FeedContext): RecorderEvent[] {
    if (this.typed.length > 0 && atTs - this.lastTypeTs >= this.opts.typeSilenceFlushMs) {
      return this.flushType(ctx);
    }
    return [];
  }

  /**
   * Emit the buffered typing as one `type` event. The app/element are
   * whatever the flush context carries — the service passes the app
   * snapshot of the typing period on focus-driven flushes, and enriches
   * the element via probe afterwards.
   */
  private flushType(ctx: FeedContext): RecorderEvent[] {
    if (this.typed.length === 0) {
      return [];
    }
    const text = this.typed.map((k) => k.text).join('');
    const ts = this.typed[this.typed.length - 1]?.ts ?? this.opts.now();
    this.typed = [];
    const event: RecorderEvent = {
      type: 'type',
      ts,
      app: ctx.app,
      text: ctx.redact === true ? REDACTED_TEXT : text,
      element: NO_ELEMENT,
    };
    return [event];
  }

  // --- mouse ------------------------------------------------------------

  private feedMouseUp(event: MouseUpEvent, ctx: FeedContext): RecorderEvent[] {
    const pending = this.pendingClick;
    this.pendingClick = null;
    if (!pending || pending.button !== event.button) {
      // Press without a matching up (or cross-button weirdness): record
      // nothing rather than guess geometry.
      return [];
    }
    if (pending.button >= 4) {
      // Extra mouse buttons have no slot in the RecorderEvent model.
      return [];
    }
    // A click interrupts typing AND a wheel run (both belong to the
    // pre-click moment; ordering matters).
    const flush = [ ...this.flushType(ctx), ...this.flushPendingWheel(ctx)];
    const count = pending.clicks >= 2 ? 2 : 1;
    const button: 'left' | 'right' | 'middle' =
      pending.button === 1 ? 'left'
      : pending.button === 2 ? 'right'
      : 'middle';
    const clickEvent: RecorderEvent = {
      type: 'click',
      ts: event.ts,
      app: ctx.app,
      click: { x: pending.x, y: pending.y, button, count },
      element: NO_ELEMENT,
    };
    return [...flush, clickEvent];
  }

  // --- wheel ------------------------------------------------------------

  private feedWheel(event: WheelEvent, ctx: FeedContext): RecorderEvent[] {
    // libuiohook inverts the Windows vertical delta: rotation > 0 means
    // the wheel rotated toward the user = content scrolls down.
    const direction: 'up' | 'down' = event.rotation > 0 ? 'down' : 'up';
    const pending = this.pendingWheel;
    if (
      pending &&
      pending.direction === direction &&
      event.ts - pending.lastTs <= this.opts.wheelDebounceMs
    ) {
      pending.amount += Math.max(1, Math.abs(event.rotation));
      pending.lastTs = event.ts;
      return [];
    }
    const flush = this.flushPendingWheel(ctx);
    this.pendingWheel = {
      direction,
      amount: Math.max(1, Math.abs(event.rotation)),
      firstTs: event.ts,
      lastTs: event.ts,
    };
    return flush;
  }

  private flushPendingWheel(ctx: FeedContext): RecorderEvent[] {
    const pending = this.pendingWheel;
    this.pendingWheel = null;
    return pending ? [this.emitWheel(pending, ctx)] : [];
  }

  private emitWheel(pending: PendingWheel, ctx: FeedContext): RecorderEvent {
    return {
      type: 'scroll',
      ts: pending.lastTs,
      app: ctx.app,
      direction: pending.direction,
      amount: pending.amount,
    };
  }

  // --- shared -----------------------------------------------------------

  private flushAll(app: AppRef, ctx: FeedContext): RecorderEvent[] {
    const appCtx: FeedContext = { ...ctx, app };
    return [...this.flushType(appCtx), ...this.flushPendingWheel(appCtx)];
  }
}

/**
 * The duya CLI terminal UI.
 *
 * ## What this replaces
 *
 * `repl.ts` — a readline REPL with chalk colours. It works, and it is still
 * the fallback for a non-interactive process. This is the surface a user gets
 * when both ends of the process are a terminal.
 *
 * ## What this is built around
 *
 * A stream of per-token frames and an O(screen area) renderer. Those two facts
 * determine everything below:
 *
 * - deltas land in a `DeltaBuffer` and are committed by LINE, or when stale
 *   (`delta-buffer.ts`);
 * - commits are paced through a two-gear `Pacer` (`pacer.ts`);
 * - renders are coalesced by a trailing-edge `RenderScheduler`
 *   (`render-scheduler.ts`);
 * - keyboard input bypasses the scheduler entirely.
 *
 * ## Three things blessed does not do, done here
 *
 * 1. **Synchronized output.** Each render is wrapped in DECSET/DECRST 2026 so
 *    a frame is presented atomically instead of painting in.
 * 2. **Bounded output.** Frames go through `EscapeSafeWriter`, which caps a
 *    flush and never cuts an escape sequence in half.
 * 3. **Bracketed paste.** Enabled here, because blessed never enables `?2004`.
 *    Measured safe: blessed's `_listenInput` drops the `ESC[200~`/`ESC[201~`
 *    markers on the floor, so enabling the mode does not leak them to the
 *    editor.
 */

import blessed from 'blessed';
import type { BlessedProgram, Widgets } from 'blessed';
import { TranscriptModel, type LegacyFrame, type Block } from './blocks.js';
import { DeltaBuffer } from './delta-buffer.js';
import { RenderScheduler } from './render-scheduler.js';
import { Pacer } from './pacer.js';
import { PasteBurstDetector } from './paste-burst.js';
import { InputEditor } from './editor.js';
import { OverlayState, type PermissionDecision } from './overlay.js';
import { renderTranscript, type RenderOptions } from './transcript-view.js';
import { EscapeSafeWriter } from './bounded-writer.js';
import { wrapWithCursor, type WrappedText } from './width.js';

/** DECSET 2026: begin synchronized update. */
const SYNC_BEGIN = '\x1b[?2026h';
/** DECRST 2026: end synchronized update. */
const SYNC_END = '\x1b[?2026l';

/** Lines the input box may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 8;

/** Height of the status bar, in rows. */
const STATUS_ROWS = 1;

/** How long a second Ctrl+C stays lethal. */
const DOUBLE_CTRL_C_MS = 2000;

/** Where the synchronized-output markers are written. */
export interface TUIAppOptions {
  /** Window title. */
  readonly title?: string;
  /**
   * Sink for the rendered frames.
   *
   * Injectable so the blessed integration can be exercised by a test without
   * a terminal: the writer still coalesces and still refuses to split an
   * escape sequence, but the bytes land somewhere a test can read them. In
   * production this is `process.stdout`.
   */
  readonly output?: NodeJS.WritableStream;
  /**
   * Source of key events. Injectable for the same reason as `output`, so a
   * test can feed synthetic keystrokes without claiming the real stdin.
   */
  readonly input?: NodeJS.ReadableStream;
  /** Status bar text, recomputed on every render. */
  readonly statusText?: () => string;
  /** Seed history, e.g. from `~/.duya/.cli_history`. */
  readonly history?: readonly string[];
  /** Called with each submitted prompt. */
  readonly onSubmit: (text: string) => void | Promise<void>;
  /** Called on the first Ctrl+C while a turn is running. */
  readonly onInterrupt?: () => void;
  /** Called on the second Ctrl+C inside `DOUBLE_CTRL_C_MS`, or `/exit`. */
  readonly onExit?: () => void;
  /** True while a turn is running, for the status bar. */
  readonly isBusy?: () => boolean;
  /** True when a permission responder is attached to the run. */
  readonly canAnswerPermissions?: () => boolean;
}

export class TUIApp {
  private readonly options: TUIAppOptions;
  private readonly screen: Widgets.Screen;
  private readonly program: BlessedProgram;
  private readonly writer: EscapeSafeWriter;
  /** Where the synchronized-output markers go, alongside the frames. */
  private readonly output: NodeJS.WritableStream;

  private readonly transcriptBox: Widgets.BoxElement;
  private readonly inputBox: Widgets.BoxElement;
  private readonly statusBar: Widgets.BoxElement;
  private readonly overlayBox: Widgets.BoxElement;

  private readonly model = new TranscriptModel();
  private readonly editor = new InputEditor();
  private readonly overlay = new OverlayState();
  private readonly scheduler: RenderScheduler;

  /** Per stream: assistant text and thinking text get their own buffers. */
  private readonly textBuffer = new DeltaBuffer();
  private readonly thinkingBuffer = new DeltaBuffer();
  private readonly pacer = new Pacer();
  private readonly paste = new PasteBurstDetector();

  private expanded = false;
  /** Tail-following. Disengaged by scrolling up, restored by Ctrl+End. */
  private follow = true;
  /**
   * How many lines the view is scrolled back from the tail.
   *
   * Zero means "following". This is the whole scroll state: the transcript box
   * is never handed more content than it has rows, so the offset is the only
   * thing that decides which slice of the model is on screen.
   */
  private scrollLines = 0;
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;
  private running = false;
  /** Lines committed to the model but not yet accounted for by a render. */
  private queuedLines = 0;
  private oldestQueuedAt = Number.NEGATIVE_INFINITY;
  private busy = false;

  /** Rows currently visible in the input box, for cursor clamping. */
  private inputRows = 1;
  /** Last wrap result, so `placeCursor` need not re-wrap. */
  private inputCursor: WrappedText = { rows: [''], cursorRow: 1, cursorCol: 0 };

  constructor(options: TUIAppOptions) {
    this.options = options;

    this.output = options.output ?? process.stdout;

    // The writer is built before the screen because the program is constructed
    // from it, and a program cannot be swapped afterwards.
    this.writer = new EscapeSafeWriter({ sink: this.output });

    // Geometry is published on the writer BEFORE the program is constructed.
    // `Program`'s constructor reads `output.columns` / `output.rows` / `isTTY`
    // once, to size the screen — a plain sink has none of them, so publishing
    // afterwards leaves the screen sized from `undefined` and every box empty.
    const proxy = this.writer as unknown as Record<string, unknown>;
    proxy.columns = process.stdout.columns ?? 80;
    proxy.rows = process.stdout.rows ?? 24;
    proxy.isTTY = true;
    proxy.on = (event: string, listener: () => void): unknown => {
      // Geometry changes come from the real terminal, whichever stream the
      // frames are going to.
      if (event === 'resize') process.stdout.on('resize', listener);
      return proxy;
    };

    this.program = blessed.program({
      input: (options.input ?? process.stdin) as unknown as NodeJS.ReadStream,
      output: this.writer as unknown as NodeJS.WriteStream,
      terminal: process.env.TERM ?? 'xterm-256color',
      // The cursor is positioned explicitly after each render; letting
      // blessed draw its own would fight the editor's cursor placement.
      // `artificial: false` means blessed leaves the real terminal cursor
      // alone rather than drawing a block over the cell.
      cursor: { artificial: false, shape: 'line', blink: false, color: '' },
      colors: 256,
    });

    this.screen = blessed.screen({
      program: this.program,
      smartCSR: true,
      fullUnicode: true,
      title: options.title ?? 'duya',
    }) as Widgets.Screen;

    this.transcriptBox = blessed.box({
      top: 0,
      left: 0,
      right: 0,
      bottom: 3 + STATUS_ROWS,
      // NOT `scrollable`. The window is owned by `TranscriptModel` and applied
      // in `paintTranscript`, because blessed's scrollable measures against
      // `_clines`/`_pcontent`, which are only rebuilt by `parseContent` and
      // therefore lag the content by one coalesced render batch. Handing the
      // box a buffer taller than the screen and asking it to scroll is what
      // made a streaming answer appear frozen at the top with the newest
      // lines stranded below the fold. See `paintTranscript`.
      keys: false,
      vi: false,
      tags: true,
      border: { type: 'line' },
      label: ' transcript ',
      style: { border: { fg: 'gray' } },
    }) as Widgets.BoxElement;

    this.inputBox = blessed.box({
      bottom: STATUS_ROWS,
      left: 0,
      right: 0,
      height: 3,
      keys: true,
      vi: true,
      tags: true,
      border: { type: 'line' },
      label: ' input ',
      style: { border: { fg: 'green' } },
    }) as Widgets.BoxElement;

    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      right: 0,
      height: STATUS_ROWS,
      tags: true,
      content: '',
    }) as Widgets.BoxElement;

    this.overlayBox = blessed.box({
      top: 'center',
      left: 'center',
      width: '70%',
      // Sized from the body on every paint; see `paintOverlay`.
      height: 7,
      hidden: true,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      keys: true,
      vi: true,
    }) as Widgets.BoxElement;

    this.screen.append(this.transcriptBox);
    this.screen.append(this.inputBox);
    this.screen.append(this.statusBar);
    // Appended LAST so it paints over the transcript. Blessed renders
    // `screen.children` in order, and an element passed `parent:` in its
    // options is NOT added to that list — it has to be appended here or it is
    // never drawn at all.
    this.screen.append(this.overlayBox);

    if (options.history !== undefined && options.history.length > 0) {
      this.editor.loadHistory(options.history);
    }

    this.scheduler = new RenderScheduler({ onRender: () => this.paint() });

    this.bindKeys();
    this.bindPaste();
    this.bindResize();

    // Bracketed paste: blessed never enables it, and without it a paste
    // arrives as a key storm. See the module comment for why the markers
    // this causes are harmless.
    this.program.setMode('?2004');
  }

  /** Begin the session. */
  start(): void {
    this.running = true;
    this.model.addNotice('Ctrl+C interrupt · Ctrl+L clear · Ctrl+T expand · PgUp/PgDn scroll · Ctrl+End follow');
    this.scheduler.requestImmediate();
  }

  /** Tear down, restoring the terminal. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
    this.program.resetMode('?2004');
    this.screen.destroy();
    this.writer.flush();
  }

  // ---------------------------------------------------------------- rendering

  /**
   * The one place `screen.render()` is called.
   *
   * Wrapped in synchronized output so the frame is presented at once, and so
   * that the sequence is emitted even when the render throws — otherwise a
   * failed render leaves the terminal in synchronized mode, where it swallows
   * output until the mode is reset.
   */
  private paint(): void {
    if (!this.running) return;
    this.output.write(SYNC_BEGIN);
    try {
      // Input FIRST: it owns the box geometry, and the transcript scroll is
      // computed against that geometry. Painting the transcript first would
      // size its scroll against the PREVIOUS frame's height.
      this.paintInput();
      this.paintTranscript();
      this.paintStatus();
      this.paintOverlay();
      this.screen.render();
      this.placeCursor();
    } finally {
      // In the `finally`, not the happy path: a render that throws would
      // otherwise leave the terminal in synchronized mode, where it stops
      // displaying output until the mode is reset.
      this.output.write(SYNC_END);
    }
  }

  private renderOptions(): RenderOptions {
    return { expanded: this.expanded, showToolResults: this.expanded, toolResultLines: 5 };
  }

  private paintTranscript(): void {
    const lines = renderTranscript(this.model, this.renderOptions()).split('\n');
    const rows = this.visibleTranscriptRows();
    // The window ends at the last line and only drops lines from the top, so
    // "following" is the state where `scrollLines` is 0 rather than a special
    // case. That is what stops a streaming answer from ending up with its
    // newest lines stranded below the fold.
    const maxStart = Math.max(0, lines.length - rows);
    const start = Math.max(0, Math.min(maxStart, maxStart - this.scrollLines));
    this.transcriptBox.setContent(lines.slice(start).join('\n'));
  }

  /**
   * Rows the transcript can actually paint.
   *
   * Derived from the terminal rather than from the box's last measured height,
   * so the first frame — before blessed has laid anything out — still gets a
   * real window instead of a one-line one.
   */
  private visibleTranscriptRows(): number {
    const screenRows = asNumber(this.program.rows, 24);
    // input box (rows + its two border rows), status bar, the transcript's own
    // top and bottom border.
    return Math.max(1, screenRows - this.inputRows - asNumber(this.inputBox.iheight, 2) - STATUS_ROWS - 2);
  }

  private paintInput(): void {
    const width = Math.max(1, asNumber(this.inputBox.width, 20) - asNumber(this.inputBox.iwidth, 2));
    const wrapped = wrapWithCursor(this.editor.text, width, this.editor.cursor);
    const rows = Math.min(MAX_INPUT_ROWS, Math.max(1, wrapped.rows.length));
    const height = rows + asNumber(this.inputBox.iheight, 2);
    this.inputBox.height = height;
    this.inputBox.bottom = STATUS_ROWS;
    this.transcriptBox.bottom = height + STATUS_ROWS;

    const visible = wrapped.rows.slice(0, rows);
    this.inputBox.setContent(visible.join('\n'));
    // Recorded so `placeCursor` can put the real cursor where the editor
    // thinks it is, without re-wrapping.
    this.inputRows = rows;
    this.inputCursor = wrapped;
  }

  private placeCursor(): void {
    const box = this.inputBox;
    if (box.lpos === undefined) return;
    // Clamp into the visible window: the editor's logical row may be below
    // the fold once the box has hit MAX_INPUT_ROWS.
    const row = Math.min(this.inputCursor.cursorRow, this.inputRows) - 1;
    const col = asNumber(box.left) + asNumber(box.ileft, 1) + this.inputCursor.cursorCol;
    const y = asNumber(box.top) + asNumber(box.itop, 1) + row;
    this.program.move(Math.max(0, col), Math.max(0, y));
    this.program.showCursor();
  }

  private paintStatus(): void {
    const text = this.options.statusText?.() ?? '';
    const busy = this.options.isBusy?.() ?? this.busy;
    const tail = this.follow ? '' : ' {gray-fg}[paused]{/gray-fg}';
    this.statusBar.setContent(`{gray-fg}${text}{/gray-fg}${tail}`);
  }

  private paintOverlay(): void {
    const body = this.overlay.body(this.options.canAnswerPermissions?.() ?? false);
    if (body === null) {
      if (!this.overlayBox.hidden) this.overlayBox.hide();
      return;
    }
    // Height is set explicitly rather than left to blessed's `'auto'`: a box
    // that starts hidden has no measured height to auto-size from, and an
    // overlay that renders at zero height is an overlay that never appears.
    this.overlayBox.height = body.split('\n').length + 2;
    this.overlayBox.setContent(body);
    if (this.overlayBox.hidden) this.overlayBox.show();
  }

  // ------------------------------------------------------------------- events

  /** Feed one frame from the run. The only entry point for run output. */
  push(frame: LegacyFrame): void {
    switch (frame.type) {
      case 'text_delta': {
        this.textBuffer.append(readContent(frame), now());
        this.drainBuffers();
        return;
      }
      case 'thinking_delta': {
        this.thinkingBuffer.append(readContent(frame), now());
        this.drainBuffers();
        return;
      }
      case 'permission': {
        // Settle any previous request before showing the next one.
        this.overlay.decide(null);
        this.showPermission(frame);
        return;
      }
      default:
        break;
    }

    const result = this.model.apply(frame);
    if (result.kind === 'permission') {
      this.showPermission(frame);
      return;
    }
    if (result.kind !== 'none') this.scheduleRender();
  }

  private showPermission(frame: LegacyFrame): void {
    const data = (typeof frame.data === 'object' && frame.data !== null
      ? frame.data
      : {}) as Record<string, unknown>;
    const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : '';
    if (requestId === '') return;

    this.overlay.show(
      {
        requestId,
        toolName: typeof data['toolName'] === 'string' ? data['toolName'] : '',
        toolInput: data['toolInput'],
        reason: typeof data['reason'] === 'string' ? data['reason'] : '',
        blockedPath: typeof data['blockedPath'] === 'string' ? data['blockedPath'] : undefined,
      },
      (decision: PermissionDecision | null) => {
        this.onPermissionDecision?.(requestId, decision);
        this.scheduleRender();
      },
    );
    this.scheduleRender();
  }

  /** Set by the wiring so a decision has somewhere to go. */
  onPermissionDecision?: (requestId: string, decision: PermissionDecision | null) => void;

  /**
   * Commit buffered deltas into the block model.
   *
   * This is the whole point of the design: the ONLY thing a delta does is
   * append to a buffer. Nothing here renders. Whether the committed lines are
   * actually painted is the scheduler's and the pacer's decision.
   */
  private drainBuffers(): void {
    const at = now();
    const text = this.textBuffer.take(at);
    if (text !== '') {
      this.model.appendTextDelta(text);
      this.noteQueued(text);
    }
    const thinking = this.thinkingBuffer.take(at);
    if (thinking !== '') {
      this.model.appendThinkingDelta(thinking);
      this.noteQueued(thinking);
    }
    this.scheduleRender();
  }

  private noteQueued(committed: string): void {
    const lines = committed.split('\n').length - 1;
    if (lines <= 0) return;
    if (this.queuedLines === 0) this.oldestQueuedAt = now();
    this.queuedLines += lines;
  }

  /**
   * Ask for a render, letting the pacer choose the gear.
   *
   * `flush` bypasses the throttle entirely and commits the backlog in one
   * render, which is what catch-up means.
   */
  private scheduleRender(): void {
    const at = now();
    const age = Math.max(
      this.queuedLines === 0 ? 0 : at - this.oldestQueuedAt,
      this.textBuffer.oldestPendingAge(at),
      this.thinkingBuffer.oldestPendingAge(at),
    );
    const signal = this.pacer.observe(this.queuedLines, age, at);

    if (signal === 'flush') {
      this.queuedLines = 0;
      this.oldestQueuedAt = Number.NEGATIVE_INFINITY;
      this.scheduler.requestImmediate();
      return;
    }
    if (this.queuedLines > 0) {
      // Lines have been committed, so they have been accounted for by this
      // decision; clearing here is what stops the backlog from growing
      // without bound while the throttle coalesces renders.
      this.queuedLines = 0;
      this.oldestQueuedAt = Number.NEGATIVE_INFINITY;
    }
    this.scheduler.request();
  }

  /** Mark the turn running or idle. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.pacer.reset();
    if (!busy) {
      // A turn boundary commits whatever is left, so the transcript cannot
      // disagree with what actually happened.
      const tail = this.textBuffer.flush();
      if (tail !== '') this.model.appendTextDelta(tail);
      const thought = this.thinkingBuffer.flush();
      if (thought !== '') this.model.appendThinkingDelta(thought);
    }
    this.scheduleRender();
  }

  /** Clear the transcript and the input. */
  clearTranscript(): void {
    this.model.clear();
    this.textBuffer.reset();
    this.thinkingBuffer.reset();
    this.editor.clear();
    this.follow = true;
    this.scrollLines = 0;
    this.scheduler.requestImmediate();
  }

  /**
   * Append a single-line notice and render it.
   *
   * The entry point for text that did not come from the run: slash-command
   * output captured off `console`, and the start-up banner.
   */
  printNotice(text: string): void {
    if (text.trim() === '') return;
    this.model.addNotice(text);
    this.scheduleRender();
  }

  /** Append an error and render it. Never collapsed, never truncated. */
  printError(message: string): void {
    if (message.trim() === '') return;
    this.model.addError(message);
    this.scheduleRender();
  }

  /** The persisted input history. */
  exportHistory(): string[] {
    return this.editor.exportHistory();
  }

  /** Render options, exposed so tests can drive the shell. */
  get renderState(): { expanded: boolean; follow: boolean } {
    return { expanded: this.expanded, follow: this.follow };
  }

  // --------------------------------------------------------------------- keys

  /** Key names handled by a dedicated binding rather than by insertion. */
  private static readonly SPECIAL_KEYS = new Set([
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'pageup',
    'pagedown',
    'delete',
    'backspace',
    'return',
    'enter',
    'tab',
    'escape',
    'clear',
    'f1',
  ]);

  private bindKeys(): void {
    const target = this.screen;

    target.key(['C-c'], () => this.onCtrlC());
    target.key(['C-l'], () => {
      this.clearTranscript();
    });
    target.key(['C-t'], () => {
      this.expanded = !this.expanded;
      this.scheduler.requestImmediate();
    });
    target.key(['C-a'], () => this.editor.moveHome());
    target.key(['C-e'], () => this.editor.moveEnd());
    target.key(['C-u'], () => this.editor.killToStart());
    target.key(['C-k'], () => this.editor.killToEnd());
    target.key(['C-w'], () => this.editor.killWordBackward());
    target.key(['C-end'], () => this.followTail());
    target.key(['escape'], () => this.closeOverlay());

    target.key(['up'], () => this.editor.historyPrevious());
    target.key(['down'], () => this.editor.historyNext());
    target.key(['left'], () => this.editor.moveLeft());
    target.key(['right'], () => this.editor.moveRight());
    target.key(['C-left'], () => this.editor.moveWordLeft());
    target.key(['C-right'], () => this.editor.moveWordRight());
    target.key(['home'], () => this.editor.moveHome());
    target.key(['end'], () => this.editor.moveEnd());
    target.key(['backspace'], () => this.editor.backspace());
    target.key(['delete'], () => this.editor.deleteForward());
    target.key(['tab'], () => this.editor.insert('  '));

    target.key(['pageup'], () => {
      this.scrollBy(-1);
    });
    target.key(['pagedown'], () => {
      this.scrollBy(1);
    });

    target.key(['return', 'enter'], () => this.onEnter());

    // Everything else is text. Notably this is where CJK arrives: measured on
    // blessed's key path a committed ideograph arrives with `key.name`
    // undefined and `ch` holding the character, so the name-keyed bindings
    // above never see it and it lands here instead.
    target.on('keypress', (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      const name = key?.name;
      if (typeof name === 'string' && TUIApp.SPECIAL_KEYS.has(name)) {
        this.scheduler.requestImmediate();
        return;
      }
      if (typeof name === 'string' && name.length > 1 && name !== 'space') {
        this.scheduler.requestImmediate();
        return;
      }
      if (typeof ch !== 'string' || ch.length === 0) return;
      if (this.overlay.isActive) {
        // The overlay answers with single keys; they must not also land in
        // the prompt underneath it.
        this.handleOverlayKey(ch, key);
        return;
      }
      this.editor.insert(ch);
      this.paste.feed(ch, now());
      this.scheduler.requestImmediate();
    });
  }

  private handleOverlayKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    const name = key?.name ?? ch;
    if (name === 'y') return this.overlay.decide('once');
    if (name === 'n') return this.overlay.decide('deny');
    if (name === 'a') return this.overlay.decide('always');
    if (name === 'escape') return this.overlay.decide(null);
    this.scheduler.requestImmediate();
  }

  private onEnter(): void {
    if (this.overlay.isActive) {
      // Enter has no meaning against a permission prompt; ignoring it is
      // safer than silently defaulting to "deny".
      this.scheduler.requestImmediate();
      return;
    }
    const at = now();
    if (this.paste.isPastedEnter(at)) {
      // A pasted newline is CONTENT, not a submission. Treating it as a
      // submit is how one paste starts three agent runs.
      this.paste.clear(at);
      this.editor.insert('\n');
      this.scheduler.requestImmediate();
      return;
    }
    this.paste.clear(at);
    const text = this.editor.submitIfPresent();
    if (text === null) {
      this.scheduler.requestImmediate();
      return;
    }
    this.model.addUser(text);
    this.follow = true;
    // Render the user's own line before the turn starts, so the transcript
    // shows what was asked rather than jumping straight to the answer.
    this.scheduler.requestImmediate();
    void this.options.onSubmit(text);
  }

  private onCtrlC(): void {
    const at = now();
    if (at - this.lastCtrlCAt < DOUBLE_CTRL_C_MS) {
      this.options.onExit?.();
      this.stop();
      return;
    }
    this.lastCtrlCAt = at;
    this.options.onInterrupt?.();
    this.scheduler.requestImmediate();
  }

  private closeOverlay(): void {
    if (!this.overlay.isActive) return;
    this.overlay.decide(null);
    this.scheduler.requestImmediate();
  }

  private followTail(): void {
    this.follow = true;
    this.scrollLines = 0;
    this.scheduler.requestImmediate();
  }

  private scrollBy(pages: number): void {
    const rows = this.visibleTranscriptRows();
    const total = renderTranscript(this.model, this.renderOptions()).split('\n').length;
    const maxBack = Math.max(0, total - rows);
    const next = pages < 0
      ? Math.min(maxBack, this.scrollLines - pages * rows)
      : Math.max(0, this.scrollLines - pages * rows);
    this.scrollLines = next;
    // Scrolling back to the newest line IS following again; scrolling away
    // from it is not. Deriving this from the offset rather than setting it
    // separately is what stops "I scrolled to the bottom but it still says
    // paused" from being reachable.
    this.follow = this.scrollLines === 0;
    this.scheduler.requestImmediate();
  }

  // ------------------------------------------------------------------ plumbing

  private bindPaste(): void {
    // Nothing to attach: `?2004` is set in the constructor and blessed
    // already drops the markers. Kept as a named seam so the behaviour has a
    // place to be documented and tested rather than living in a constructor.
  }

  private bindResize(): void {
    process.stdout.on('resize', () => {
      this.scheduler.requestImmediate();
    });
  }
}

function now(): number {
  return performance.now();
}

/**
 * Blessed types geometry as `number | string | 'center'`, because an element
 * may be positioned by either. This shell only ever sets numeric geometry, so
 * a non-number here is a layout that has not been applied yet — and the
 * fallback is the right answer for that rather than `NaN` arithmetic.
 */
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Read `data.content`, tolerating both shapes the wire uses. */
function readContent(frame: LegacyFrame): string {
  const { data } = frame;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

export type { Block, LegacyFrame };
export default TUIApp;

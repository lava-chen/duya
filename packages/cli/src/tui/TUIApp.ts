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

// The VALUE import survives only for `blessed.program`, which is the input
// channel: keypress events still arrive through it, because parsing terminal
// bytes into events is a separate seam from drawing and Phase 1 only moved the
// drawing. When input moves too, this import goes with it.
import blessed from 'blessed';
import type { BlessedProgram, Widgets } from 'blessed';
import { PassThrough } from 'node:stream';
import { createScreenSurface, selectScreenRenderer, type ScreenRenderer, type ScreenSurface } from './screen/index.js';
import { TranscriptModel, readBlockKey, type LegacyFrame, type Block } from './blocks.js';
import { DeltaBuffer, DEFAULT_STALE_MS } from './delta-buffer.js';
import { RenderScheduler } from './render-scheduler.js';
import { Pacer } from './pacer.js';
import { PasteBurstDetector } from './paste-burst.js';
import { InputEditor } from './editor.js';
import { OverlayState, isDestructiveRequest, type PermissionDecision, type QuestionAnswers } from './overlay.js';
import { escapeTags, stylesOf, type RenderOptions } from './transcript-view.js';
import { TranscriptRenderer } from './transcript-cache.js';
import type { EscapeSafeWriter } from './bounded-writer.js';
import { TerminalSession } from './terminal/session.js';
import { OwnKeyInput, OwnKeyParser } from './terminal/own-key-parser.js';
import { buildComposerLayout } from './composer-layout.js';
import { wrapWithCursor, type WrappedText } from './width.js';
import { CompletionController, type CompletionKey, type CompletionSources } from './completion.js';
import { WindowManager } from './window.js';
import { ACTION_DEFS, helpGroups, keysColumn, type ActionDef } from './actions.js';
import { applyKeyOverrides, loadKeyOverrides, toBlessedKeys, REBINDABLE_ACTIONS, validateKeyOverrides, type KeymapIssue } from './keymap.js';
import { resolveThemeName, themeFor, type ThemeName } from './theme.js';
import { compactActivity } from './text.js';
import { resolveStatusLabel } from './status-label.js';
import { detectTerminalEnvironment, type TerminalEnvironment } from './terminal-env.js';
import {
  nextSpinnerFrame,
  spinnerGlyph,
  workingTailLine,
  WORKING_TAIL_INTERVAL_MS,
} from './working-tail.js';
import { InlineSurface } from './terminal/surface.js';
import { conversationRegionBottom, type TerminalSize } from './terminal/viewport.js';
import type { Message as TranscriptMessage, MessageContent } from '@duya/agent-protocol/transcript';

/** DECSET 2026: begin synchronized update. */
const SYNC_BEGIN = '\x1b[?2026h';
/** DECRST 2026: end synchronized update. */
const SYNC_END = '\x1b[?2026l';

/** Lines the input box may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 8;

/** Height of the status bar, in rows. */
const STATUS_ROWS = 1;

/** Share of the terminal width the centred overlay takes. */
const OVERLAY_WIDTH = '70%';

/**
 * Columns the inline composer holds back from the right edge.
 *
 * Two, matching the border the full-screen composer has, so a line that fits
 * inline fits in the old layout too.
 */
const COMPOSER_INSET = 2;

/** Transcript lines moved per wheel tick. Three is the conventional step. */
const WHEEL_STEP_LINES = 3;

/** How long a second Ctrl+C stays lethal. */
const DOUBLE_CTRL_C_MS = 2000;

function transcriptText(content: string | readonly MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return block.thinking;
    if (block.type === 'tool_result') return transcriptText(block.content);
    if (block.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

const EMPTY_COMPLETION_SOURCES: CompletionSources = {
  slash: () => [],
  context: () => [],
  files: () => [],
};

type ActivityPhase = 'ready' | 'working' | 'thinking' | 'responding' | 'compacting' | 'complete' | 'failed';

/** A row in a keyboard-driven modal picker. */
export interface TuiChoice {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

type InteractivePrompt =
  | { kind: 'select'; title: string; choices: readonly TuiChoice[]; selectedIndex: number }
  | { kind: 'text'; title: string; value: string; cursor: number; secret: boolean; placeholder: string };

const PROMPT_VISIBLE_CHOICES = 9;

function frameRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function frameString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] as string : '';
}

function renderOptionsKey(options: RenderOptions, width: number): string {
  const ids = (values: ReadonlySet<string> | undefined): string[] =>
    [...(values ?? [])].sort();
  return JSON.stringify({
    width,
    expanded: options.expanded,
    showToolResults: options.showToolResults,
    toolResultLines: options.toolResultLines,
    expandedBlockIds: ids(options.expandedBlockIds),
    collapsedBlockIds: ids(options.collapsedBlockIds),
    selectedBlockId: options.selectedBlockId ?? null,
    theme: options.theme ?? null,
  });
}

/** Where the synchronized-output markers are written. */
/**
 * What the TUI asked blessed to render with.
 *
 * Published on the writer before `blessed.program`/`blessed.screen` are called,
 * and the same object is passed to them, so a test can assert the terminal's
 * capabilities actually reached the renderer rather than trusting that a
 * constant stayed correct.
 */
export interface RenderConfig {
  readonly program: {
    readonly terminal: string;
    readonly colors: number;
  };
  readonly screen: {
    readonly fullUnicode: boolean;
  };
}

export interface TUIAppOptions {  /** Window title. */
  readonly title?: string;
  /** Renderer override; by default DUYA_TUI_RENDERER selects the implementation. */
  readonly renderer?: ScreenRenderer;
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
  readonly statusText?: () => string;  /** Seed history, e.g. from `~/.duya/.cli_history`. */
  readonly history?: readonly string[];
  /** Called with each submitted prompt. */
  readonly onSubmit: (text: string) => void | Promise<void>;
  /** Let the controller own accepted-message echo and pending drafts. */
  readonly echoSubmitted?: boolean;
  readonly canSubmit?: () => boolean;
  readonly queuedPrompts?: () => readonly string[];
  readonly queuePaused?: () => boolean;
  readonly onRecallQueued?: () => string | null;
  /** Called on the first Ctrl+C while a turn is running. */
  readonly onInterrupt?: () => void;
  /** Called on the second Ctrl+C inside `DOUBLE_CTRL_C_MS`, or `/exit`. */
  readonly onExit?: () => void;
  /** True while a turn is running, for the status bar. */
  readonly isBusy?: () => boolean;
  /** True when a permission responder is attached to the run. */
  readonly canAnswerPermissions?: () => boolean;
  /**
   * Prompts queued behind the running turn, for the status bar's `⧗ N`
   * segment. The TUI cannot see the session's queue itself — the queue lives
   * in the wiring — so the host reports it.
   */
  readonly queuedCount?: () => number;
  /**
   * Keybinding overrides, display form. Injected (tests, wiring) or loaded
   * from config + env; see `keymap.ts`. Only the actions in
   * `REBINDABLE_ACTIONS` get their blessed bindings rewired — the rest are
   * display-only.
   */
  readonly keyOverrides?: Readonly<Record<string, string>>;
  /**
   * Context-window budget in tokens, when the caller can resolve one for the
   * active model. Gates the context bar in the status bar and the Ctrl+P
   * window; `null` or a non-positive value falls back to the bare session
   * total.
   */
  readonly contextBudgetTokens?: () => number | null;
  /** Override the theme (`'dark' | 'light'`); defaults to `resolveThemeName()`. */
  readonly theme?: ThemeName;
  /**
   * Where completion candidates come from.
   *
   * Defaults to empty sources. The host injects its command and workspace data,
   * keeping this terminal UI independent from the runtime and command registry.
   */
  readonly completionSources?: CompletionSources;
  /** How many completion rows to show at once. */
  readonly completionRows?: number;
  /**
   * Terminal capabilities. Injected by tests; defaults to detection from
   * `process.env`. Every rendering choice that used to be a hard-coded
   * constant (colour count, box characters) comes from here instead.
   */
  readonly terminalEnv?: TerminalEnvironment;
  /**
   * Render into the terminal's own scrollback instead of a full-screen window.
   *
   * The conversation is printed as it finishes and stays readable after the TUI
   * exits, which a fixed window cannot offer. Off by default while this is
   * proven against real terminals; `DUYA_TUI_INLINE=1` turns it on.
   *
   * In this mode blessed's `Screen` is never constructed — it switches to the
   * alternate buffer in its constructor, and an alternate buffer has no
   * scrollback to commit into. Its `Program` is still used, for input only.
   */
  readonly inline?: boolean;
}

export class TUIApp {
  private readonly options: TUIAppOptions;
  /**
   * Null in inline mode until an overlay needs it.
   *
   * Blessed switches to the alternate buffer in the Screen CONSTRUCTOR, and an
   * alternate buffer has no scrollback — committing the conversation into it
   * would put the history somewhere the user cannot scroll back to. So inline
   * mode builds no Screen at all and renders its own frames.
   *
   * It builds one LAZILY, for the overlay only, the way codex does: an overlay
   * is a modal takeover, and the one thing a full-screen buffer is good at.
   */
  private readonly fullScreen: ScreenSurface;
  private disposed = false;
  private readonly terminal: TerminalSession;
  private readonly renderer: ScreenRenderer;
  private readonly ownKeyInput: OwnKeyInput | null;
  private readonly program: BlessedProgram;
  private readonly writer: EscapeSafeWriter;
  /** What the terminal can render, measured rather than assumed. */
  private readonly terminalEnv: TerminalEnvironment;
  /** Inline write path; null in full-screen mode. */
  private readonly inlineSurface: InlineSurface | null;
  /**
   * The frame under construction, in visual order, captured by the paint
   * methods before they hand it to a surface. Inline mode writes these arrays
   * straight out; full-screen mode patches the surface's regions with them.
   */
  private inlineTranscriptLines: string[] = [];
  private inlinePopupLines: string[] = [];
  private inlineInputLines: string[] = [];
  private inlineStatusLines: string[] = [];
  /** Where the synchronized-output markers go, alongside the frames. */
  private readonly output: NodeJS.WritableStream;

  private readonly completion: CompletionController;
  /** Rows the popup shows. */
  private readonly completionRows: number;

  private readonly model = new TranscriptModel();
  private readonly editor = new InputEditor();
  private readonly overlay = new OverlayState();
  /** Login/provider wizard prompt. Values never pass through the chat editor. */
  private interactivePrompt: InteractivePrompt | null = null;
  private interactivePromptResolver: ((value: string | null) => void) | null = null;
  private readonly scheduler: RenderScheduler;

  /** Per stream: assistant text and thinking text get their own buffers. */
  private readonly textBuffer = new DeltaBuffer();
  private readonly thinkingBuffer = new DeltaBuffer();
  private deltaDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pacer = new Pacer();
  private readonly paste = new PasteBurstDetector();

  private expanded = false;
  private focus: 'input' | 'transcript' = 'input';
  private selectedBlockIndex = -1;
  private readonly expandedBlockIds = new Set<string>();
  private readonly collapsedBlockIds = new Set<string>();
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
  /**
   * Cache-fed transcript renderer. Every paint asks it for the window slice;
   * unchanged blocks come back as cached line arrays, so a streaming frame
   * re-renders only the block that actually changed.
   */
  private readonly transcript = new TranscriptRenderer();
  /** Lines assembled for the last private model revision and render options. */
  private transcriptRevision = 0;
  private cachedTranscriptLines: {
    readonly revision: number;
    readonly optionsKey: string;
    readonly lines: string[];
  } | null = null;
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;
  private running = false;
  /** Lines committed to the model but not yet accounted for by a render. */
  private queuedLines = 0;
  private oldestQueuedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private activityPhase: ActivityPhase = 'ready';
  private activityMessage = '';
  private groupActivity = '';
  private waitingForPermission = false;
  private readonly activeTools = new Map<string, { name: string; elapsedSeconds: number | null }>();
  private readonly activeAgents = new Map<string, string>();
  /**
   * The working tail's spinner.
   *
   * Chrome, never transcript — see `working-tail.ts` for why a row the surface
   * rewrites is the only kind of row that can hold a spinner.
   */
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  /** Modal windows (F1 help, Ctrl+R history, Ctrl+P usage). */
  private readonly windowMgr = new WindowManager();
  /** Palette for the transcript and the windows. Assigned in the constructor. */
  private readonly theme: ReturnType<typeof themeFor>;
  /**
   * The action table with this session's overrides applied. The help window
   * renders from it, and the rebindable global toggles dispatch from it —
   * one table, one truth, per instance rather than per module, because the
   * overrides come from config + env.
   */
  private readonly actionDefs: readonly ActionDef[];
  /**
   * Problems with this session's key overrides, resolved once with
   * `actionDefs`. Reported as transcript notices in `start()`: an override
   * that silently does not bind is worse than one that is refused loudly,
   * because the help window still renders the requested key.
   */
  private readonly keymapIssues: readonly KeymapIssue[];
  /** Usage of the most recent billed call, from `token_usage` frames. */
  private lastUsage: { input: number; output: number; total: number } | null = null;
  /** Sum of every `token_usage` total seen this session. */
  private sessionTokens = 0;

  /** Rows currently visible in the input box, for cursor clamping. */
  private inputRows = 1;
  private readonly composerBorder = { type: 'line' as const, left: false, right: false };
  /** Last wrap result, so `placeCursor` need not re-wrap. */
  private inputCursor: WrappedText = { rows: [''], cursorRow: 1, cursorCol: 0 };

  constructor(options: TUIAppOptions) {
    this.options = options;
    this.renderer = selectScreenRenderer(options.renderer);
    // Capabilities first: the theme fallback below is a rendering decision, so
    // it must not be made before we know what the terminal can render.
    this.terminalEnv = options.terminalEnv ?? detectTerminalEnvironment();
    const requestedTheme = options.theme ?? resolveThemeName();
    // A light theme on a 16-colour terminal does not degrade, it disintegrates:
    // the palette is 256-colour numbers, so every tag quantises to something
    // arbitrary. Falling back keeps the reading experience; the user can still
    // force `light` on a 256-colour terminal where it works.
    this.theme = themeFor(
      requestedTheme === 'light' && !this.terminalEnv.supportsLightPalette ? 'dark' : requestedTheme,
    );
    // Overrides resolved ONCE, here: config + env, with the injected map (a
    // test seam) winning outright when present.
    const keyOverrides = options.keyOverrides ?? loadKeyOverrides();
    this.actionDefs = applyKeyOverrides(ACTION_DEFS, keyOverrides);
    // Validated against the SAME map that produced `actionDefs`, so the help
    // window and the reported problems cannot describe different sessions.
    this.keymapIssues = validateKeyOverrides(ACTION_DEFS, keyOverrides);

    this.terminal = new TerminalSession({ input: options.input, output: options.output });
    this.writer = this.terminal.writer;
    this.output = this.writer;
    const proxy = this.writer as unknown as Record<string, unknown>;
    const programInput = this.renderer === 'own' ? new PassThrough() : this.terminal.input;

    // The blessed options are built ONCE, published for tests, and then handed
    // to blessed by reference — not rebuilt inside the call. That is what makes
    // the wiring assertable: a test reading `renderConfig.program.colors` is
    // reading the very object `Program` was constructed from, so putting a
    // constant back inside `blessed.program({...})` cannot leave the published
    // copy still agreeing with reality.
    const programOptions = {
      input: programInput as unknown as NodeJS.ReadStream,
      output: this.writer as unknown as NodeJS.WriteStream,
      terminal: this.terminalEnv.term,
      // The cursor is positioned explicitly after each render; letting
      // blessed draw its own would fight the editor's cursor placement.
      // `artificial: false` means blessed leaves the real terminal cursor
      // alone rather than drawing a block over the cell.
      cursor: { artificial: false, shape: 'line', blink: false, color: '' } as const,
      // 16 covers truecolor too: blessed's `colors: 16` is the 24-bit path,
      // while anything higher is the 256-colour palette.
      colors: this.terminalEnv.colorDepth === 'truecolor' ? 16 : this.terminalEnv.colorDepth,
    };
    this.program = blessed.program(programOptions);

    const screenOptions = {
      program: this.program,
      smartCSR: true,
      fullUnicode: this.terminalEnv.unicodeBox,
      title: options.title ?? 'duya',
    };
    // Both option objects are published AND passed by reference, so what a test
    // reads is what the renderer was constructed from. Publishing a copy instead
    // would leave this seam able to describe a renderer that was never built —
    // which is exactly what a `fullUnicode: true` left in the screen call did
    // while every colour test stayed green.
    const renderConfig: RenderConfig = { program: programOptions, screen: screenOptions };
    proxy.renderConfig = renderConfig;

    const inline = options.inline === true;
    this.inlineSurface = inline
      ? new InlineSurface({
          output: this.output,
          size: () => this.terminalSize(),
        })
      : null;
    this.completionRows = Math.max(1, options.completionRows ?? 8);
    this.completion = new CompletionController(
      options.completionSources ?? EMPTY_COMPLETION_SOURCES,
    );

    this.fullScreen = createScreenSurface({
      program: this.program,
      screenOptions,
      statusRows: STATUS_ROWS,
      overlayWidth: OVERLAY_WIDTH,
      output: this.output,
      getSize: () => this.terminalSize(),
      unicodeBox: this.terminalEnv.unicodeBox,
      renderer: this.renderer,
    });

    // Full-screen mode builds its five regions now. Inline mode keeps the
    // alternate buffer unopened until an overlay raises it: `blessed.screen`
    // enters that buffer as a side effect of construction, and there is no way
    // back out of it in the middle of a frame. The surface creates it lazily for
    // exactly that case, which is why the inline tail no longer needs its own
    // copy of everything below.
    if (!inline) this.fullScreen.attachAll();

    if (options.history !== undefined && options.history.length > 0) {
      this.editor.loadHistory(options.history);
    }

    this.scheduler = new RenderScheduler({ onRender: () => this.paint() });

    this.bindKeys();
    this.bindPaste();
    this.bindResize();

    this.ownKeyInput = this.renderer === 'own'
      ? new OwnKeyInput(this.terminal.input, new OwnKeyParser({
          keypress: (ch, key) => {
            (programInput as PassThrough).emit('keypress', ch, key);
          },
          paste: (text) => this.handleBracketedPaste(text),
          mouse: (event) => { this.program.emit('mouse', event); },
        }))
      : null;

    // Bracketed paste: blessed never enables it, and without it a paste
    // arrives as a key storm. See the module comment for why the markers
    // this causes are harmless.
    this.program.setMode('?2004');
  }

  /**
   * Rows and columns, read live rather than cached.
   *
   * `process.stdout` first: it is the tty itself and it is what the `resize`
   * listener updates, so it is correct on the very first frame and on every
   * frame after a resize. `program` is the fallback for a test that drives the
   * app with a fake output stream.
   */
  private terminalSize(): TerminalSize {
    return this.terminal.size();
  }

  /**
   * A full-screen buffer, built on demand, for the overlay only.
   *
   * This is codex's split: the conversation lives in the normal screen's
   * scrollback, and an overlay is the one thing that takes the screen over. So
   * inline mode keeps no Screen between overlays and pays for the alternate
   * buffer only while a prompt, a permission request, or a modal window is up.
   *
   * The return value is nothing on purpose: every caller wanted the buffer to
   * EXIST, not to hold it, and the surface owns it.
   */
  private ensureAltScreen(): void {
    this.fullScreen.ensure();
  }

  /** Leave the modal buffer without destroying the shared input Program. */
  private suspendAltScreen(): void {
    this.fullScreen.leave();
    this.inlineSurface?.invalidate();
  }

  private releaseAltScreen(): void {
    this.fullScreen.destroy();
  }

  /** Begin the session. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.model.addNotice('duya · / commands · F1 help');
    // Every issue is shown, not just the errors: a keymap warning is a
    // binding the user believes in and the terminal does not deliver, and the
    // only moment the user is guaranteed to read the transcript is the start.
    for (const issue of this.keymapIssues) {
      this.model.addNotice(`keymap: ${issue.message} ${issue.remedy}`);
    }
    this.noteTranscriptMutation();
    this.scheduler.requestImmediate();
  }

  /** Tear down, restoring the terminal. */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.settleInteractivePrompt(null);
    this.overlay.abortAll();
    this.windowMgr.close();
    this.scheduler.stop();
    if (this.deltaDrainTimer !== null) clearTimeout(this.deltaDrainTimer);
    this.deltaDrainTimer = null;
    // Without this the terminal stays in mouse reporting after exit, and the
    // shell the user returns to swallows clicks and wheel events.
    this.program.disableMouse();
    this.program.resetMode('?2004');
    // Exactly one of these exists. Destroying a Screen leaves the alternate
    // buffer; `InlineSurface.stop` leaves the conversation on the normal one.
    this.releaseAltScreen();
    this.inlineSurface?.stop();
    this.stopSpinner();
    this.ownKeyInput?.dispose();
    this.program.destroy();
    this.terminal.dispose();
  }

  /** Repaint external controller state, such as pending follow-ups. */
  refresh(): void {
    this.scheduler.requestImmediate();
  }

  /** Open a keyboard-navigable modal and resolve with the selected value. */
  choose(title: string, choices: readonly TuiChoice[]): Promise<string | null> {
    if (choices.length === 0) return Promise.resolve(null);
    this.assertPromptAvailable();
    this.completion.close();
    this.interactivePrompt = { kind: 'select', title, choices, selectedIndex: 0 };
    this.scheduler.requestImmediate();
    return new Promise((resolve) => {
      this.interactivePromptResolver = resolve;
    });
  }

  /** Show a read-only information panel from a slash command. */
  showPanel(
    title: string,
    lines: readonly string[],
    options: { readonly footer?: string; readonly scrollable?: boolean } = {},
  ): void {
    if (this.windowOpenBlocked()) return;
    this.completion.close();
    this.windowMgr.open({
      title,
      lines,
      ...(options.footer === undefined ? {} : { footer: options.footer }),
      ...(options.scrollable === undefined ? {} : { scrollable: options.scrollable }),
    });
    this.scheduler.requestImmediate();
  }

  /** Open a fuzzy-filtered list window and resolve with the selected value. */
  chooseFiltered(
    title: string,
    choices: readonly TuiChoice[],
    options: { readonly initialFilter?: string; readonly footer?: string } = {},
  ): Promise<string | null> {
    if (choices.length === 0 || this.interactivePrompt !== null || this.overlay.isActive) {
      return Promise.resolve(null);
    }
    this.completion.close();
    let resolveSelection: (value: string | null) => void = () => {};
    const selection = new Promise<string | null>((resolve) => {
      resolveSelection = resolve;
    });
    this.windowMgr.open({
      title,
      items: choices,
      filterable: true,
      ...(options.initialFilter ? { initialFilter: options.initialFilter } : {}),
      footer: options.footer ?? 'type to filter · ↑↓ choose · Enter resume · Esc close',
      onSubmit: (value) => resolveSelection(value),
      onCancel: () => resolveSelection(null),
    });
    this.scheduler.requestImmediate();
    return selection;
  }

  /** Open a one-line prompt. Secret values render as bullets and bypass history. */
  promptText(
    title: string,
    options: { initialValue?: string; secret?: boolean; placeholder?: string } = {},
  ): Promise<string | null> {
    this.assertPromptAvailable();
    this.completion.close();
    const value = options.initialValue ?? '';
    this.interactivePrompt = {
      kind: 'text',
      title,
      value,
      cursor: value.length,
      secret: options.secret === true,
      placeholder: options.placeholder ?? '',
    };
    this.scheduler.requestImmediate();
    return new Promise((resolve) => {
      this.interactivePromptResolver = resolve;
    });
  }

  private assertPromptAvailable(): void {
    if (this.interactivePrompt !== null) {
      throw new Error('A TUI prompt is already open');
    }
  }

  private settleInteractivePrompt(value: string | null): void {
    if (this.interactivePrompt === null) return;
    this.interactivePrompt = null;
    const resolve = this.interactivePromptResolver;
    this.interactivePromptResolver = null;
    resolve?.(value);
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  // ---------------------------------------------------------------- rendering

  /**
   * The one place a frame reaches the terminal.
   *
   * Two paths, chosen by what exists: a Screen means blessed owns the drawing,
   * and the frame is wrapped in synchronized output so it is presented at once
   * and so the sequence is emitted even when the render throws — a failed render
   * would otherwise leave the terminal in synchronized mode, where it swallows
   * output until the mode is reset.
   *
   * No Screen means inline mode, and there `InlineSurface` does its own
   * synchronized-output framing per frame. Wrapping it again here would be
   * closed early by the inner frame's terminator, which turns the outer one into
   * no effect at all.
   */
  private paint(): void {
    if (!this.running) return;
    this.syncSpinner();
    if (this.inlineSurface !== null) {
      this.paintInline();
      return;
    }
    this.output.write(SYNC_BEGIN);
    try {
      // Input FIRST: it owns the box geometry, and the transcript scroll is
      // computed against that geometry. Painting the transcript first would
      // size its scroll against the PREVIOUS frame's height.
      this.paintInput();
      this.paintTranscript();
      this.paintCompletion();
      this.paintStatus();
      this.paintOverlay();
      this.fullScreen.render();
      this.placeCursor();
    } finally {
      this.output.write(SYNC_END);
    }
  }

  /**
   * Compose the frame inline and hand it to the surface.
   *
   * The paint methods are shared; only the destination differs. Each one writes
   * its rows into a blessed box in full-screen mode and into a capture array
   * here, so the two paths cannot disagree about what the frame contains.
   */
  private paintInline(): void {
    this.inlineTranscriptLines = [];
    this.inlinePopupLines = [];
    this.inlineInputLines = [];
    this.inlineStatusLines = [];

    this.paintInput();
    this.paintTranscript();
    this.paintCompletion();
    this.paintStatus();
    // The overlay is a full-screen takeover, so inline mode needs a Screen for
    // it. Building one here — rather than at construction — is what keeps the
    // alternate buffer out of the way while the conversation is on screen.
    if (this.overlayActive()) this.ensureAltScreen();
    else this.suspendAltScreen();

    if (this.fullScreen.ready && !this.fullScreen.suspended) {
      this.paintOverlay();
      this.fullScreen.render();
      this.placeCursor();
      return;
    }

    const tail = this.workingTailLines();
    const queued = this.queuePreviewLines();
    const chrome = [...tail, ...queued, ...this.inlinePopupLines, ...this.inlineInputLines, ...this.inlineStatusLines];
    // The caret's row is an index into `scroll`, so it is offset by everything
    // that sits above the composer. Its column is the editor's own column plus
    // the prompt marker's width, because that is what is actually printed.
    const caret =
      this.focus === 'input' && this.interactivePrompt === null
        ? {
            row:
              tail.length +
              queued.length +
              this.inlinePopupLines.length +
              this.inputCursor.cursorRow - 1,
            column: this.inputCursor.cursorCol + 1,
            region: 'chrome' as const,
          }
        : null;
    this.inlineSurface?.render({
      scroll: this.inlineTranscriptLines,
      chrome,
      caret,
      // Scrolling back must not commit: those rows may be wanted again, and the
      // terminal cannot be told to take a committed row back.
      ...(this.scrollLines > 0
        ? { viewEnd: Math.max(0, this.inlineTranscriptLines.length - this.scrollLines) }
        : {}),
    });
  }

  /** True when something needs the full-screen takeover. */
  private overlayActive(): boolean {
    if (this.interactivePrompt !== null) return true;
    if (this.overlay.body(this.options.canAnswerPermissions?.() ?? false) !== null) return true;
    return this.windowMgr.isActive;
  }

  /**
   * The working tail: one row, empty when nothing is running.
   *
   * Shown only in inline mode. Full-screen mode has a fixed four-row layout and
   * the status line is where its activity has always lived; giving it a tail too
   * is a separate change to that layout, not something to smuggle in here.
   */
  private workingTailLines(): string[] {
    // Keyed on the inline surface, not on the absence of the status bar: the
    // status bar being null IS inline mode today, but a full-screen mode that
    // grows its own tail later must not be switched off by this line.
    if (this.inlineSurface === null) return [];
    const busy = this.options.isBusy?.() ?? this.busy;
    if (!busy && !this.waitingForPermission) return [];
    return [
      workingTailLine({
        frame: this.spinnerFrame,
        label: this.activityLabel(busy),
        unicode: this.terminalEnv.unicodeBox,
        columns: this.terminalSize().columns,
      }),
    ];
  }

  /**
   * Run the spinner clock while there is a turn in flight.
   *
   * It advances an index and asks for a THROTTLED render — it never paints, and
   * it never touches the transcript. `unref`d, because a timer that outlives
   * the TUI would keep the process alive after `/exit`.
   */
  private syncSpinner(): void {
    const busy = this.options.isBusy?.() ?? this.busy;
    const wanted = busy || this.waitingForPermission;
    if (!wanted) {
      this.spinnerFrame = 0;
      if (this.spinnerTimer !== null) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      return;
    }
    if (this.spinnerTimer !== null) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = nextSpinnerFrame(this.spinnerFrame, this.terminalEnv.unicodeBox);
      this.scheduleRender();
    }, WORKING_TAIL_INTERVAL_MS);
    this.spinnerTimer.unref?.();
  }

  /** Stop the spinner clock. Called from teardown. */
  private stopSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private renderOptions(): RenderOptions {
    const selectedBlock = this.model.blocks[this.selectedBlockIndex];
    return {
      expanded: this.expanded,
      showToolResults: this.expanded,
      toolResultLines: 5,
      expandedBlockIds: this.expandedBlockIds,
      collapsedBlockIds: this.collapsedBlockIds,
      theme: this.theme.tags,
      ...(this.focus === 'transcript' && selectedBlock !== undefined
        ? { selectedBlockId: selectedBlock.id }
        : {}),
    };
  }

  /** Invalidate the assembled lines after a private transcript-model change. */
  private noteTranscriptMutation(): void {
    this.transcriptRevision += 1;
    this.cachedTranscriptLines = null;
  }

  private paintTranscript(): void {
    const options = this.renderOptions();
    const optionsKey = renderOptionsKey(options, this.terminalSize().columns);
    let lines: string[];
    if (
      this.cachedTranscriptLines?.revision === this.transcriptRevision &&
      this.cachedTranscriptLines.optionsKey === optionsKey
    ) {
      lines = this.cachedTranscriptLines.lines;
    } else {
      lines = this.transcript.lines(this.model, options);
      this.cachedTranscriptLines = {
        revision: this.transcriptRevision,
        optionsKey,
        lines,
      };
    }
    if (this.inlineSurface !== null) {
      // The WHOLE transcript, unwindowed. Deciding what the live area shows and
      // committing the rest to scrollback is the surface's job, and it cannot do
      // either if the transcript arrives pre-sliced: "which rows scrolled off" is
      // exactly the information that slicing destroys.
      this.inlineTranscriptLines = lines;
      return;
    }
    const rows = this.visibleTranscriptRows();
    // The window ends at the last line and only drops lines from the top, so
    // "following" is the state where `scrollLines` is 0 rather than a special
    // case. That is what stops a streaming answer from ending up with its
    // newest lines stranded below the fold.
    const maxStart = Math.max(0, lines.length - rows);
    const start = Math.max(0, Math.min(maxStart, maxStart - this.scrollLines));
    this.fullScreen.update('transcript', {
      borderColor: this.focus === 'transcript' ? 'cyan' : 'gray',
      lines: lines.slice(start),
    });
  }

  /**
   * Rows the transcript can actually paint.
   *
   * Derived from the terminal rather than from the region's last measured height,
   * so the first frame — before the renderer has laid anything out — still gets a
   * real window instead of a one-line one.
   */
  private visibleTranscriptRows(): number {
    const screenRows = asNumber(this.program.rows, 24);
    // input box (rows + its two border rows), status bar, the popup while it is
    // open, and the transcript's own top and bottom border.
    return Math.max(
      1,
      screenRows -
        this.inputRows -
        this.inputChromeRows() -
        STATUS_ROWS -
        2 -
        this.popupRows(),
    );
  }

  /** Widget border rows; tiny fullscreen composers temporarily omit borders. */
  private inputChromeRows(): number {
    return asNumber(this.fullScreen.measure('input')?.innerHeight, 2);
  }

  /** Rows the popup occupies right now, borders included. Zero when closed. */
  private popupRows(): number {
    if (!this.completion.isOpen) return 0;
    const total = this.completion.snapshot.items.length;
    const rows = Math.min(this.completionRows, total);
    const hasOverflowMarker = total > rows;
    // One more row when the list is scrollable, for the ellipsis.
    return rows + (hasOverflowMarker ? 1 : 0) + 2;
  }

  /**
   * Columns the composer can wrap at.
   *
   * Full-screen mode asks the surface what it actually laid out. Inline mode has
   * no layout pass, so it reads the terminal — otherwise the composer would wrap
   * at a 20-column default and every answer would look mangled.
   */
  private composerWidth(): number {
    const measured = this.fullScreen.measure('input');
    if (this.inlineSurface === null && measured !== null && measured.width > 0) {
      return Math.max(1, measured.width - measured.innerWidth);
    }
    return Math.max(1, this.terminalSize().columns - COMPOSER_INSET);
  }

  private paintInput(): void {
    const size = this.terminalSize();
    const inline = this.inlineSurface !== null;
    const availableRows = Math.max(1, size.rows - STATUS_ROWS -
      (inline ? this.workingTailLines().length + this.queuePreviewLines().length : 0) - this.popupRows());
    if (!inline) {
      // Blessed computes padding from the presence of a border object, even
      // when individual edges are false. Remove the object on tiny screens.
      this.fullScreen.update('input', {
        borderStyle: availableRows >= 3 ? 'composer' : 'none',
      });
    }
    const layout = buildComposerLayout(this.editor.text, this.editor.cursor, {
      columns: inline ? Math.max(1, size.columns - 1) : this.composerWidth(),
      terminalRows: availableRows,
      maxRows: MAX_INPUT_ROWS,
      unicode: this.terminalEnv.unicodeBox,
    });
    const borderRows = layout.lines.length - layout.bodyRows;
    if (!inline) {
      const height = layout.bodyRows + this.inputChromeRows();
      const body = borderRows > 0 ? layout.lines.slice(1, -1) : layout.lines;
      this.fullScreen.update('input', {
        borderColor: this.focus === 'input' ? 'gray' : 'black',
        height,
        bottom: Math.min(STATUS_ROWS, Math.max(0, size.rows - 1)),
        lines: body.map(escapeTags),
      });
      this.fullScreen.update('transcript', {
        bottom: height + STATUS_ROWS + this.popupRows(),
      });
    } else {
      this.inlineInputLines = layout.lines.map(escapeTags);
    }
    this.inputRows = layout.bodyRows;
    this.inputCursor = {
      rows: layout.lines,
      cursorRow: layout.cursorRow - (inline ? 0 : borderRows / 2),
      cursorCol: layout.cursorColumn - 1,
    };
  }

  private queuePreviewLines(): string[] {
    const pending = this.options.queuedPrompts?.() ?? [];
    if (pending.length === 0 || this.terminalSize().rows < 7) return [];
    const label = this.options.queuePaused?.() ? 'paused' : 'queued';
    const latest = pending[pending.length - 1] ?? '';
    return [escapeTags(compactActivity(
      label + ' (' + pending.length + ') · ' + latest.replace(/\s+/gu, ' '),
      Math.max(1, this.terminalSize().columns - 1),
    ))];
  }

  private placeCursor(): void {
    if (this.focus !== 'input' || this.interactivePrompt !== null) {
      this.program.hideCursor();
      return;
    }
    // Inline mode places its own caret, in absolute rows and columns, as part of
    // the frame. Full-screen mode asks the surface where the composer landed.
    const input = this.fullScreen.measure('input');
    if (input === null || !input.laidOut) return;
    // Clamp into the visible window: the editor's logical row may be below
    // the fold once the region has hit MAX_INPUT_ROWS.
    const row = Math.min(this.inputCursor.cursorRow, this.inputRows) - 1;
    const col = input.left + input.innerLeft + this.inputCursor.cursorCol;
    const y = input.top + input.innerTop + row;
    this.program.move(Math.max(0, col), Math.max(0, y));
    this.program.showCursor();
  }

  /**
 * Draw the popup, or hide it.
 *
 * Sits immediately above the input box and steals transcript rows while it is
 * open, so the transcript is shortened by exactly the popup height rather than
 * being overlapped — an overlapped popup would hide the very text the user is
 * completing against.
 */
private paintCompletion(): void {
    const state = this.completion.snapshot;
    if (!this.completion.isOpen) {
      if (this.inlineSurface !== null) this.inlinePopupLines = [];
      else this.fullScreen.update('completion', { hidden: true });
      return;
    }

    const total = state.items.length;
    const visible = Math.min(this.completionRows, total);
    // Window the selection into view. Without this, accepting row 30 of a
    // 100-row list would insert something the user never saw.
    const first = Math.max(
      0,
      Math.min(state.selectedIndex - (visible - 1), Math.max(0, total - visible)),
    );

    const rows: string[] = [];
    for (let i = first; i < first + visible; i += 1) {
      const entry = state.items[i];
      if (entry === undefined) continue;
      const selected = i === state.selectedIndex;
      const marker = selected ? '❯' : ' ';
      const description = entry.description === '' ? '' : `  {gray-fg}${entry.description}{/gray-fg}`;
      const line = `${marker} ${entry.label}${description}`;
      rows.push(selected ? `{cyan-fg}${line}{/cyan-fg}` : line);
    }

    if (first > 0) rows.unshift('{gray-fg}  …{/gray-fg}');
    if (first + visible < total) rows.push('{gray-fg}  …{/gray-fg}');

    if (this.inlineSurface !== null) {
      this.inlinePopupLines = rows;
      return;
    }

    // `+ 2` for the popup own border rows.
    this.fullScreen.update('completion', {
      height: rows.length + 2,
      bottom: this.visibleInputHeight() + STATUS_ROWS,
      lines: rows,
      hidden: false,
    });
  }

  /** Total rows the input box occupies, borders included. */
  private visibleInputHeight(): number {
    return this.inputRows + this.inputChromeRows();
  }

  private paintStatus(): void {
    const text = compactActivity(this.options.statusText?.() ?? '', 28);
    const busy = this.options.isBusy?.() ?? this.busy;
    const spinner = busy || this.waitingForPermission
      ? `${spinnerGlyph(this.spinnerFrame, this.terminalEnv.unicodeBox)} `
      : '';
    const tail = this.follow ? '' : ' [paused]';
    const blockCount = this.model.blocks.length;
    const selection = this.selectedBlockIndex < 0 ? 0 : this.selectedBlockIndex + 1;
    const context = this.interactivePrompt?.kind === 'select'
      ? 'Enter select / Esc cancel'
      : this.interactivePrompt?.kind === 'text'
        ? 'Enter confirm / Esc cancel'
        : this.completion.isOpen
      ? this.completion.snapshot.argumentCommand !== undefined
        ? 'Enter run / Tab fill / arrows choose'
        : 'Tab accept / arrows choose'
      : busy
        ? 'Ctrl+C stop / Ctrl+T expand'
      : this.focus === 'transcript'
        ? `history ${selection}/${blockCount} / arrows select / left-right fold`
        : `${this.editor.isEmpty ? 'Tab history' : 'Tab indent'} / F6 focus / arrows prompts`;
    // The status line is chrome, so in inline mode it is a row inside the live
    // area — and a row that wraps moves every row below it, which is how an
    // inline TUI's geometry goes wrong on a narrow terminal. `?7l` is disabled
    // around every frame for exactly this, but it is a request, not a
    // guarantee: measured on Windows ConPTY, a line that reaches the last column
    // wraps anyway and the frame lands one row lower than intended.
    //
    // So the line is fitted to the terminal instead of trusted to wrap. One
    // column is left spare because a line that exactly fills the width is the
    // case that wraps.
    const width = Math.max(1, this.terminalSize().columns - 1);
    const usage = this.usageSegment();
    // Queued-prompt count: the visible half of the busy-time queue, so a
    // user can see their follow-up prompts exist without digging for the
    // "queued (N)" transcript line that acknowledged each one.
    const queued = this.options.queuedCount?.() ?? 0;
    const queueSegment = queued > 0 ? ` · ⧗ ${queued}` : '';
    if (this.inlineSurface !== null) {
      const hint = this.options.queuePaused?.() && queued > 0
        ? '/queue resume · Esc edit queued'
        : this.completion.isOpen ? context
        : busy ? 'Enter queue · Esc interrupt' : '/ commands · F1 help';
      this.inlineStatusLines = [escapeTags(compactActivity(text + usage + ' · ' + hint, width))];
      return;
    }
    const fixed = text + ' · ' + spinner + this.activityLabel(busy) + tail + usage + queueSegment + ' · ' + context;
    this.fullScreen.update('status', {
      lines: ['{gray-fg}' + escapeTags(compactActivity(fixed, width)) + '{/gray-fg}'],
    });
  }

  /**
   * Status-bar token segment: the context bar when a budget is resolvable,
   * otherwise the bare session total. Empty until the first `token_usage`
   * frame, so an idle prompt shows nothing.
   */
  private usageSegment(): string {
    const budget = this.options.contextBudgetTokens?.() ?? null;
    if (budget !== null && budget > 0) return ` · ${this.contextBar()} ${this.contextPercent()}%`;
    if (this.sessionTokens > 0) return ` · Σ ${formatTokens(this.sessionTokens)}`;
    return '';
  }

  /** Show the most useful live activity without adding one transcript row per tick. */
  private activityLabel(busy: boolean): string {
    if (this.waitingForPermission) return 'Waiting for approval';

    const tools = [...this.activeTools.values()];
    const tool = tools[tools.length - 1];
    const agents = [...this.activeAgents.values()];
    const agent = agents[agents.length - 1];
    if (tool !== undefined) {
      const elapsed = tool.elapsedSeconds === null || tool.elapsedSeconds < 1
        ? ''
        : ` (${Math.floor(tool.elapsedSeconds)}s)`;
      const agentLabel = agent === undefined ? '' : ` / ${agent}`;
      return compactActivity(`${tool.name}${elapsed}${agentLabel}`);
    }
    if (agent !== undefined) {
      const count = agents.length > 1 ? `+${agents.length - 1} ` : '';
      return compactActivity(`${count}${agent} working`);
    }
    if (this.groupActivity !== '') return compactActivity(this.groupActivity);
    if (this.activityMessage !== '') return compactActivity(this.activityMessage);

    switch (this.activityPhase) {
      case 'thinking': return 'Thinking';
      case 'responding': return 'Writing response';
      case 'compacting': return 'Compacting context';
      case 'complete': return 'Completed';
      case 'failed': return 'Failed';
      case 'working': return 'Working';
      case 'ready': return busy ? 'Working' : 'Ready';
    }
  }

  /** Track only lifecycle facts already present in the run frame stream. */
  private updateActivity(frame: LegacyFrame): boolean {
    const data = frameRecord(frame.data);
    switch (frame.type) {
      case 'text_delta':
        if (this.activityPhase === 'responding' && this.activityMessage === '' && this.groupActivity === '') return false;
        this.activityPhase = 'responding';
        this.activityMessage = '';
        this.groupActivity = '';
        return true;
      case 'thinking_delta':
        if (this.activityPhase === 'thinking' && this.activityMessage === '' && this.groupActivity === '') return false;
        this.activityPhase = 'thinking';
        this.activityMessage = '';
        this.groupActivity = '';
        return true;
      case 'tool_use_started':
      case 'tool_use': {
        const id = frameString(data, 'id');
        const name = frameString(data, 'name');
        if (id === '' || name === '') return false;
        this.activeTools.delete(id);
        this.activeTools.set(id, { name, elapsedSeconds: null });
        this.activityPhase = 'working';
        this.activityMessage = '';
        return true;
      }
      case 'tool_progress': {
        // The legacy projector carries the tool call id in `toolName`.
        const id = frameString(data, 'toolName');
        const elapsed = data['elapsedSeconds'];
        const tool = this.activeTools.get(id);
        if (tool === undefined || typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return false;
        if (tool.elapsedSeconds !== null && Math.floor(tool.elapsedSeconds) === Math.floor(elapsed)) return false;
        this.activeTools.set(id, { ...tool, elapsedSeconds: elapsed });
        return true;
      }
      case 'tool_result': {
        const id = frameString(data, 'id');
        const removed = this.activeTools.delete(id);
        if (removed) {
          this.activityPhase = this.busy ? 'working' : 'ready';
          this.activityMessage = '';
          if (this.activeTools.size === 0) this.groupActivity = '';
        }
        return removed;
      }
      case 'tool_group_progress': {
        const title = frameString(data, 'title');
        if (title === '' || title === this.groupActivity) return false;
        this.groupActivity = title;
        return true;
      }
      case 'agent_progress': {
        const eventType = frameString(data, 'agentEventType');
        const id = frameString(data, 'subagentId');
        if (eventType === 'subagent_started' && id !== '') {
          const name = frameString(data, 'agentName') || frameString(data, 'agentType') || 'Agent';
          this.activeAgents.delete(id);
          this.activeAgents.set(id, name);
          this.activityPhase = 'working';
          return true;
        }
        if (eventType === 'subagent_completed' && id !== '') return this.activeAgents.delete(id);
        return false;
      }
      case 'status': {
        // Chrome, not content: `resolveStatusLabel` also resolves the desktop's
        // `@i18n:` keys, so an unresolvable key drops out of the row instead of
        // printing its own name at the user.
        const label = resolveStatusLabel(frameString(data, 'message'));
        if (label === null || label === this.activityMessage) return false;
        this.activityMessage = label;
        this.activityPhase = 'working';
        return true;
      }
      case 'compact:start':
        this.activityPhase = 'compacting';
        this.activityMessage = '';
        this.groupActivity = '';
        return true;
      case 'compact:done':
        this.activityPhase = this.busy ? 'working' : 'ready';
        this.groupActivity = '';
        return true;
      case 'compact:error':
        this.activityPhase = 'working';
        this.activityMessage = 'Compaction failed';
        this.groupActivity = '';
        return true;
      case 'permission':
        this.waitingForPermission = true;
        return true;
      case 'done':
        this.activityPhase = 'complete';
        this.clearActiveActivity();
        return true;
      case 'error':
        this.activityPhase = 'failed';
        this.clearActiveActivity();
        return true;
      default:
        return false;
    }
  }

  private clearActiveActivity(): void {
    this.activeTools.clear();
    this.activeAgents.clear();
    this.groupActivity = '';
    this.activityMessage = '';
    this.waitingForPermission = false;
  }

  private paintOverlay(): void {
    if (!this.fullScreen.ready) return;
    const rows = this.fullScreen.rows;
    if (this.interactivePrompt !== null) {
      const prompt = this.interactivePrompt;
      const body = this.renderInteractivePrompt(prompt);
      this.fullScreen.update('overlay', {
        height: Math.min(body.split('\n').length + 2, Math.max(5, rows - 2)),
        borderColor: prompt.kind === 'text' && prompt.secret ? 'yellow' : 'cyan',
        lines: body.split('\n'),
        hidden: false,
      });
      return;
    }

    const body = this.overlay.body(this.options.canAnswerPermissions?.() ?? false);
    if (body === null) {
      // The region is shared: permission overlay first, then a modal window,
      // then nothing. Only one of the three can be on screen.
      const windowBody = this.windowMgr.render(Math.max(5, rows - 4));
      if (windowBody === null) {
        this.fullScreen.update('overlay', { hidden: true });
        return;
      }
      this.fullScreen.update('overlay', {
        height: windowBody.split('\n').length + 2,
        borderColor: 'cyan',
        lines: windowBody.split('\n'),
        hidden: false,
      });
      return;
    }
    // Height is set explicitly rather than left to the renderer's `'auto'`: a
    // region that starts hidden has no measured height to auto-size from, and an
    // overlay that renders at zero height is an overlay that never appears.
    this.fullScreen.update('overlay', {
      height: body.split('\n').length + 2,
      borderColor: 'yellow',
      lines: body.split('\n'),
      hidden: false,
    });
  }

  private renderInteractivePrompt(prompt: InteractivePrompt): string {
    const lines = [`{bold}{cyan-fg}${escapeTags(prompt.title)}{/cyan-fg}{/bold}`, ''];
    if (prompt.kind === 'select') {
      const count = prompt.choices.length;
      const first = Math.max(0, Math.min(
        prompt.selectedIndex - Math.floor(PROMPT_VISIBLE_CHOICES / 2),
        Math.max(0, count - PROMPT_VISIBLE_CHOICES),
      ));
      if (first > 0) lines.push('{gray-fg}  …{/gray-fg}');
      const maxLineChars = Math.max(20, Math.floor(asNumber(process.stdout.columns, 80) * 0.7) - 6);
      for (let i = first; i < Math.min(count, first + PROMPT_VISIBLE_CHOICES); i += 1) {
        const choice = prompt.choices[i];
        if (choice === undefined) continue;
        const selected = i === prompt.selectedIndex;
        const label = escapeTags(compactActivity(choice.label, Math.max(12, maxLineChars - 14)));
        const descriptionLimit = Math.max(0, maxLineChars - Array.from(label).length - 4);
        const description = choice.description && descriptionLimit > 0
          ? `  {gray-fg}${escapeTags(compactActivity(choice.description, descriptionLimit))}{/gray-fg}`
          : '';
        const row = `${selected ? '❯' : ' '} ${label}${description}`;
        lines.push(selected ? `{cyan-fg}${row}{/cyan-fg}` : row);
      }
      if (first + PROMPT_VISIBLE_CHOICES < count) lines.push('{gray-fg}  …{/gray-fg}');
      lines.push('', '{gray-fg}↑↓ choose · Enter select · Esc cancel{/gray-fg}');
      return lines.join('\n');
    }

    const codepoints = Array.from(prompt.value);
    const masked = prompt.secret ? codepoints.map(() => '*').join('') : prompt.value;
    const caret = prompt.secret ? Array.from(prompt.value.slice(0, prompt.cursor)).length : prompt.cursor;
    const maxVisible = Math.max(12, Math.min(56, asNumber(process.stdout.columns, 80) - 20));
    const start = Math.max(0, Math.min(caret - maxVisible + 1, masked.length - maxVisible));
    const visible = masked.slice(start, start + maxVisible);
    const visibleCaret = Math.max(0, Math.min(visible.length, caret - start));
    const displayValue = prompt.value === '' && prompt.placeholder !== ''
      ? `| {gray-fg}${escapeTags(prompt.placeholder)}{/gray-fg}`
      : `${escapeTags(visible.slice(0, visibleCaret))}|${escapeTags(visible.slice(visibleCaret))}`;
    lines.push(displayValue, '', '{gray-fg}Enter confirm · Esc cancel{/gray-fg}');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------- events

  /** Feed one frame from the run. The only entry point for run output. */
  push(frame: LegacyFrame): void {
    const activityChanged = this.updateActivity(frame);
    const key = readBlockKey(frameRecord(frame.data));

    switch (frame.type) {
      case 'text_delta': {
        this.commitIfBlockChanged(this.textBuffer, key);
        this.textBuffer.append(readContent(frame), now(), key);
        this.drainBuffers();
        return;
      }
      case 'thinking_delta': {
        this.commitIfBlockChanged(this.thinkingBuffer, key);
        this.thinkingBuffer.append(readContent(frame), now(), key);
        this.drainBuffers();
        return;
      }
      case 'permission': {
        // A fresh frame supersedes every ask still open — answering a stale
        // one would deliver a decision to a request the run has moved past.
        this.overlay.abortAll();
        this.showPermission(frame);
        return;
      }
      case 'token_usage': {
        // Display, not transcript content: the status bar and the Ctrl+P
        // window show it. Note the semantics: this frame is a SINGLE billed
        // call's snapshot (projected from `assistant.usage`), not a turn
        // total and not a context-window reading — hence "sum of billed
        // calls" everywhere it is labelled.
        const data = frameRecord(frame.data);
        const total = typeof data['total_tokens'] === 'number' ? data['total_tokens'] : 0;
        if (total <= 0) return;
        this.lastUsage = {
          input: typeof data['input_tokens'] === 'number' ? data['input_tokens'] : 0,
          output: typeof data['output_tokens'] === 'number' ? data['output_tokens'] : 0,
          total,
        };
        this.sessionTokens += total;
        this.scheduleRender();
        return;
      }
      default:
        break;
    }

    // ORDERING, not tidiness. Everything below appends to, finalises, or
    // replaces a block, so text buffered for an EARLIER content block has to
    // land first. `drainBuffers` is throttled, so without this commit the tail
    // of a paragraph written before a tool call would render BELOW that tool's
    // line — the ordering defect, from its second and timing-dependent cause.
    let transcriptChanged = this.commitBuffers();
    if (frame.type === 'text') this.textBuffer.reset();
    if (frame.type === 'thinking') this.thinkingBuffer.reset();
    const result = this.model.apply(frame);
    if (result.kind === 'append' || result.kind === 'mutate') transcriptChanged = true;
    if (transcriptChanged) this.noteTranscriptMutation();
    if (result.kind === 'permission') {
      this.showPermission(frame);
      return;
    }
    if (result.kind !== 'none' || activityChanged) this.scheduleRender();
    this.syncDeltaDrainTimer();
  }

  private showPermission(frame: LegacyFrame): void {
    const data = (typeof frame.data === 'object' && frame.data !== null
      ? frame.data
      : {}) as Record<string, unknown>;
    const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : '';
    if (requestId === '') return;
    const toolName = typeof data['toolName'] === 'string' ? data['toolName'] : '';
    const toolInput = data['toolInput'];
    const rawMode = data['mode'];
    const mode = rawMode === 'ask_user_question' || rawMode === 'exit_plan_mode'
      ? rawMode
      : 'generic';
    void this.requestPermissionApproval({
      requestId,
      toolName,
      toolInput,
      reason: typeof data['reason'] === 'string' ? data['reason'] : '',
      blockedPath: typeof data['blockedPath'] === 'string' ? data['blockedPath'] : undefined,
      mode,
      destructive: isDestructiveRequest(toolName, toolInput),
    });
  }

  /**
   * Ask the user to approve one permission request, as a promise.
   *
   * The promise-facing entrance for the ask chain: the wiring
   * (`tui-session`) calls this directly from `ChatOptions.requestPermission`,
   * and the frame-driven path (`showPermission`) routes through it too, so
   * both surfaces share the queue, the picker and the staging logic.
   *
   * Resolves with the user's decision, or `null` on Esc / timeout — the
   * wiring maps `null` to a refusal, never to an allow.
   */
  requestPermissionApproval(
    request: {
      readonly requestId: string;
      readonly toolName: string;
      readonly toolInput: unknown;
      readonly reason: string;
      readonly blockedPath?: string;
      readonly mode?: 'generic' | 'ask_user_question' | 'exit_plan_mode';
      readonly expiresAt?: number;
      readonly destructive?: boolean;
    },
  ): Promise<PermissionDecision | null> {
    // A permission question outranks any modal window; the manager and the
    // overlay share one box, so leaving the window open would let the next
    // paint draw it over the question.
    this.windowMgr.close();
    this.waitingForPermission = true;
    return new Promise<PermissionDecision | null>((resolve) => {
      this.overlay.show(request, (decision: PermissionDecision | null, answers?: QuestionAnswers) => {
        this.onPermissionDecision?.(request.requestId, decision, answers);
        this.waitingForPermission = this.overlay.isActive;
        this.activityPhase = this.busy ? 'working' : 'ready';
        resolve(decision);
        this.scheduleRender();
      });
      this.scheduleRender();
    });
  }

  /**
   * Set by the wiring so a decision has somewhere to go.
   *
   * `answers` is present only for an `ask_user_question` submit — the wiring
   * hands it to `storePendingAnswer`, keyed by the same request id the tool's
   * Phase-2 retry reads. The decision channel cannot carry it: `requestPermission`
   * returns a verdict (`allow`/`deny`), not a payload.
   */
  onPermissionDecision?: (
    requestId: string,
    decision: PermissionDecision | null,
    answers?: QuestionAnswers,
  ) => void;

  /**
   * Commit every buffered delta into the block model, ignoring the pacing
   * rules. Returns whether anything was committed.
   *
   * Called at every block boundary — a tool call, a whole-block frame, a turn
   * end — because those are the points where "one more tick of latency" stops
   * being invisible and starts being the wrong order on screen.
   */
  private commitBuffers(): boolean {
    let changed = false;
    // The key is read BEFORE the flush: `flush` clears it.
    const textKey = this.textBuffer.key;
    const text = this.textBuffer.flush();
    if (text !== '') {
      this.model.appendTextDelta(text, textKey);
      this.noteQueued(text);
      changed = true;
    }
    const thinkingKey = this.thinkingBuffer.key;
    const thinking = this.thinkingBuffer.flush();
    if (thinking !== '') {
      this.model.appendThinkingDelta(thinking, thinkingKey);
      this.noteQueued(thinking);
      changed = true;
    }
    return changed;
  }

  /**
   * Commit when the incoming fragment belongs to a DIFFERENT content block.
   *
   * `DeltaBuffer.append` refuses to cross a key boundary, and this is the
   * other half of that contract: do something sensible with the older text
   * first. Merging two blocks' deltas would render the earlier one below the
   * later one.
   */
  private commitIfBlockChanged(buffer: DeltaBuffer, key: string | null): void {
    if (buffer.isEmpty || buffer.key === key) return;
    if (this.commitBuffers()) this.noteTranscriptMutation();
  }

  /**
   * Commit buffered deltas into the block model.
   *
   * This is the whole point of the design: the ONLY thing a delta does is
   * append to a buffer. Nothing here renders. Whether the committed lines are
   * actually painted is the scheduler's and the pacer's decision.
   */
  private drainBuffers(): void {
    const at = now();
    let transcriptChanged = false;
    // Read the key before `take`: the remainder keeps it, but the returned
    // prefix belongs to it.
    const textKey = this.textBuffer.key;
    const text = this.textBuffer.take(at);
    if (text !== '') {
      this.model.appendTextDelta(text, textKey);
      transcriptChanged = true;
      this.noteQueued(text);
    }
    const thinkingKey = this.thinkingBuffer.key;
    const thinking = this.thinkingBuffer.take(at);
    if (thinking !== '') {
      this.model.appendThinkingDelta(thinking, thinkingKey);
      transcriptChanged = true;
      this.noteQueued(thinking);
    }
    if (transcriptChanged) this.noteTranscriptMutation();
    this.scheduleRender();
    this.syncDeltaDrainTimer(at);
  }

  private syncDeltaDrainTimer(at = now()): void {
    if (this.deltaDrainTimer !== null) clearTimeout(this.deltaDrainTimer);
    this.deltaDrainTimer = null;
    if (this.disposed || (this.textBuffer.isEmpty && this.thinkingBuffer.isEmpty)) return;

    const age = Math.max(
      this.textBuffer.oldestPendingAge(at),
      this.thinkingBuffer.oldestPendingAge(at),
    );
    this.deltaDrainTimer = setTimeout(() => {
      this.deltaDrainTimer = null;
      this.drainBuffers();
    }, Math.max(0, DEFAULT_STALE_MS - age));
    this.deltaDrainTimer.unref?.();
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
    if (busy) {
      this.activityPhase = 'working';
      this.clearActiveActivity();
    } else if (this.activityPhase !== 'complete' && this.activityPhase !== 'failed') {
      this.activityPhase = 'ready';
      this.clearActiveActivity();
    }
    if (!busy) {
      // A turn boundary commits whatever is left, so the transcript cannot
      // disagree with what actually happened.
      if (this.commitBuffers()) this.noteTranscriptMutation();
    }
    this.scheduleRender();
  }

  /** Clear the transcript and the input. */
  clearTranscript(): void {
    const hadTranscript = this.model.blocks.length > 0;
    this.model.clear();
    if (hadTranscript) this.noteTranscriptMutation();
    this.textBuffer.reset();
    this.thinkingBuffer.reset();
    this.editor.clear();
    this.follow = true;
    this.scrollLines = 0;
    this.focus = 'input';
    this.selectedBlockIndex = -1;
    this.expandedBlockIds.clear();
    this.collapsedBlockIds.clear();
    this.activityPhase = 'ready';
    this.clearActiveActivity();
    this.scheduler.requestImmediate();
  }

  /** Replace the visible transcript with a persisted session history. */
  replaceTranscript(messages: readonly TranscriptMessage[]): void {
    this.model.clear();
    this.textBuffer.reset();
    this.thinkingBuffer.reset();
    this.lastUsage = null;
    this.sessionTokens = 0;
    for (const message of messages) {
      if (message.visibility === 'hidden') continue;
      if (message.role === 'user') {
        const content = message.displayContent ?? message.content;
        const text = transcriptText(content);
        if (text !== '') this.model.addUser(text);
        continue;
      }
      if (message.role === 'assistant') {
        if (typeof message.thinking === 'string' && message.thinking !== '') {
          this.model.apply({ type: 'thinking', data: { content: message.thinking } });
        }
        if (typeof message.content === 'string') {
          this.model.apply({ type: 'text', data: { content: message.content } });
          continue;
        }
        let text = '';
        const flushText = (): void => {
          if (text === '') return;
          this.model.apply({ type: 'text', data: { content: text } });
          text = '';
        };
        for (const block of message.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'thinking') {
            flushText();
            this.model.apply({ type: 'thinking', data: { content: block.thinking } });
          } else if (block.type === 'tool_use') {
            flushText();
            this.model.apply({
              type: 'tool_use',
              data: { id: block.id, name: block.name, input: block.input },
            });
          } else if (block.type === 'tool_result') {
            flushText();
            this.model.apply({
              type: 'tool_result',
              data: {
                id: block.tool_use_id,
                result: transcriptText(block.content),
                error: block.is_error === true,
              },
            });
          }
        }
        flushText();
        continue;
      }
      if (message.role === 'tool' && message.tool_call_id) {
        const resultBlock = Array.isArray(message.content)
          ? message.content.find((block) => block.type === 'tool_result')
          : undefined;
        this.model.apply({
          type: 'tool_result',
          data: {
            id: message.tool_call_id,
            result: transcriptText(resultBlock?.content ?? message.content),
            error: message.status === 'error' || resultBlock?.is_error === true,
          },
        });
        continue;
      }
      if (message.role === 'system' && message.isCompactSummary === true) {
        const summary = transcriptText(message.content);
        if (summary !== '') this.model.addNotice(`Context summary: ${summary}`);
      }
    }
    this.follow = true;
    this.scrollLines = 0;
    this.focus = 'input';
    this.selectedBlockIndex = -1;
    this.expandedBlockIds.clear();
    this.collapsedBlockIds.clear();
    this.activityPhase = 'ready';
    this.clearActiveActivity();
    this.noteTranscriptMutation();
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
    this.noteTranscriptMutation();
    this.scheduleRender();
  }

  /** Append a submitted user message to the visible transcript. */
  printUser(text: string): void {
    if (text.trim() === '') return;
    this.model.addUser(text);
    this.noteTranscriptMutation();
    this.scheduleRender();
  }

  /**
   * How many times this exact text is in the transcript as its own user line.
   *
   * Exists for one regression: every prompt used to be appended twice — once
   * optimistically when Enter was pressed, once again when the turn started.
   * A full-screen window scrolled past the second copy long before a reader
   * looked, and the inline model puts the two copies side by side where the
   * duplication is the first thing on screen. `runTurn` no longer echoes.
   *
   * The count is exposed rather than asserted inside this class because the
   * duplicate was caused by TWO owners of the same fact, and a test that could
   * only be written from one of them would pass again the moment the other was
   * reintroduced. Host-backed callers disable automatic echo and append only
   * when their submission controller admits a draft to a turn.
   */
  userEchoCount(text: string): number {
    return this.model.blocks.filter((block) => block.kind === 'user' && block.text === text).length;
  }

  /** Append an error and render it. Never collapsed, never truncated. */
  printError(message: string): void {
    if (message.trim() === '') return;
    this.model.addError(message);
    this.noteTranscriptMutation();
    this.scheduleRender();
  }

  // ------------------------------------------------------------------ windows

  private windowOpenBlocked(): boolean {
    return this.interactivePrompt !== null || this.overlay.isActive;
  }

  /** Open a window, or close whichever is open when called again. */
  private toggleWindow(which: 'help' | 'history' | 'usage'): void {
    if (this.windowOpenBlocked()) return;
    if (this.windowMgr.isActive) {
      this.windowMgr.close();
      this.scheduler.requestImmediate();
      return;
    }
    if (which === 'help') this.openHelpWindow();
    else if (which === 'history') this.openHistoryWindow();
    else this.openUsageWindow();
  }

  /** Swallow an editor-directed key while a modal window is on screen. */
  private swallowForWindow(): boolean {
    if (!this.windowMgr.isActive) return false;
    this.scheduler.requestImmediate();
    return true;
  }

  /**
   * Bind one rebindable action from the effective action table.
   *
   * A display form that does not map to a blessed key name (e.g. `Wheel`)
   * binds nothing — silently, because the help window shows the display form
   * and a broken chord in config is the user's own to notice.
   */
  private bindAction(id: string, handler: () => void): void {
    if (!REBINDABLE_ACTIONS.has(id)) return;
    const def = this.actionDefs.find((candidate) => candidate.id === id);
    if (def === undefined) return;
    const keys = toBlessedKeys(def.keys);
    if (keys.length === 0) return;
    // On the program, not the screen: `Screen.prototype.key` is a one-line
    // delegation to `Program.prototype.key` (blessed screen.js:1726), so this is
    // the same binding in full-screen mode — and it is the only one available
    // in inline mode, which deliberately has no Screen.
    this.program.key(keys, handler);
  }

  /** F1: the keymap, rendered from the same table `bindKeys` documents. */
  private openHelpWindow(): void {
    if (this.windowOpenBlocked()) return;
    const styles = stylesOf({ theme: this.theme.tags });
    const headings: Record<string, string> = { global: 'Global', editor: 'Editor', transcript: 'Transcript' };
    const lines: string[] = [];
    for (const group of helpGroups(this.actionDefs)) {
      lines.push(styles.accent(headings[group.heading] ?? group.heading));
      for (const def of group.rows) {
        lines.push(`  ${escapeTags(keysColumn(def))}${styles.muted(def.label)}`);
      }
      lines.push('');
    }
    this.windowMgr.open({ title: 'Key bindings', lines, footer: 'F1 / Esc close' });
    this.scheduler.requestImmediate();
  }

  /** Ctrl+R: type-to-filter over the persisted input history. */
  private openHistoryWindow(): void {
    if (this.windowOpenBlocked()) return;
    const items = this.editor.exportHistory()
      .slice()
      .reverse()
      .map((value) => ({ label: compactActivity(value, 76), value }));
    if (items.length === 0) {
      this.model.addNotice('no input history yet');
      this.noteTranscriptMutation();
      this.scheduleRender();
      return;
    }
    this.windowMgr.open({
      title: 'Input history',
      items,
      filterable: true,
      footer: 'type to filter · Enter recall · Esc close',
      onSubmit: (value) => {
        this.focus = 'input';
        this.editor.setText(value, Array.from(value).length);
        this.refreshCompletion();
      },
    });
    this.scheduler.requestImmediate();
  }

  /** Ctrl+P: last-call usage, session total, and the context bar when budgeted. */
  private openUsageWindow(): void {
    if (this.windowOpenBlocked()) return;
    const styles = stylesOf({ theme: this.theme.tags });
    const lines: string[] = [];
    const usage = this.lastUsage;
    if (usage === null) {
      lines.push(styles.muted('no usage recorded yet'));
    } else {
      lines.push(
        `last call    in ${usage.input.toLocaleString('en-US')}`
        + ` · out ${usage.output.toLocaleString('en-US')}`
        + ` · total ${usage.total.toLocaleString('en-US')}`,
      );
    }
    lines.push(`session      ${this.sessionTokens.toLocaleString('en-US')} tokens (sum of billed calls)`);

    const budget = this.options.contextBudgetTokens?.() ?? null;
    if (budget !== null && budget > 0) {
      const pct = this.contextPercent();
      lines.push(`context      ${this.contextBar()} ${pct}% of ${formatTokens(budget)}`);
    } else {
      lines.push(styles.muted('context      budget unknown for this model'));
    }
    this.windowMgr.open({ title: 'Token usage', lines, footer: 'Esc close' });
    this.scheduler.requestImmediate();
  }

  /** Session tokens against the budget, clamped to 0–100. */
  private contextPercent(): number {
    const budget = this.options.contextBudgetTokens?.() ?? null;
    if (budget === null || budget <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((this.sessionTokens / budget) * 100)));
  }

  /**
   * Fixed-width bar for the status line and the usage window.
   *
   * Constant length on purpose: a bar that grows and shrinks with usage drags
   * the rest of the status line around, and a status line that moves is one
   * the eye cannot learn to skim.
   */
  private contextBar(cells = 8): string {
    const filled = Math.max(0, Math.min(cells, Math.round((this.contextPercent() / 100) * cells)));
    return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
  }

  /** The persisted input history. */
exportHistory(): string[] {
    return this.editor.exportHistory();
  }

  /** The current input text. Read-only; the editor owns the buffer. */
  get inputText(): string {
    return this.editor.text;
  }

  /** Render options, exposed so tests can drive the shell. */
  get renderState(): {
    expanded: boolean;
    follow: boolean;
    focus: 'input' | 'transcript';
    selectedBlockIndex: number;
  } {
    return {
      expanded: this.expanded,
      follow: this.follow,
      focus: this.focus,
      selectedBlockIndex: this.selectedBlockIndex,
    };
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
    'f6',
  ]);

  /**
   * The blessed key names bound for the completion popup — one per physical key.
   *
   * A lookup rather than a `switch` so the routing site cannot drift from the
   * fallbacks: `routeContended` indexes the same key set.
   *
   * `return` is what a terminal actually sends for Enter (`\r`). `enter` is
   * blessed's own alias for the same byte, re-emitted at `program.js:397-399`;
   * it is deliberately absent here. See `CONTENDED_ALIASES`.
   */
  private static readonly CONTENDED_BINDINGS: Readonly<Record<string, CompletionKey>> = {
    up: 'up',
    down: 'down',
    tab: 'tab',
    escape: 'escape',
    return: 'return',
  };

  /**
   * Every blessed name the popup owns, which the text handler must not also
   * read as input. A strict superset of `CONTENDED_BINDINGS` that adds
   * `enter`, the unbound alias.
   */
  private static readonly CONTENDED_ALIASES: ReadonlySet<string> = new Set([
    ...Object.keys(TUIApp.CONTENDED_BINDINGS),
    'enter',
  ]);

  private bindKeys(): void {
    // Bound to the program, never to a Screen: see `bindAction`. Inline mode
    // has no Screen, and a Screen's own key table is this program's table.
    const target = this.program;

    target.key(['C-c'], () => {
      if (this.interactivePrompt !== null) this.settleInteractivePrompt(null);
      else this.onCtrlC();
    });
    // C-l (clear) and C-t (expand-all) are bound further down, from the
    // action table, so an override rewires them in one place.
    target.key(['C-a'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(0);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveHome();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-e'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.value.length);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveEnd();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-u'], () => {
      if (this.interactivePrompt?.kind === 'text') this.updateTextPrompt({ value: this.interactivePrompt.value.slice(this.interactivePrompt.cursor), cursor: 0 });
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killToStart();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-k'], () => {
      if (this.interactivePrompt?.kind === 'text') this.updateTextPrompt({ value: this.interactivePrompt.value.slice(0, this.interactivePrompt.cursor) });
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killToEnd();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-w'], () => {
      if (this.interactivePrompt?.kind === 'text') {
        const before = this.interactivePrompt.value.slice(0, this.interactivePrompt.cursor).replace(/\s+$/u, '').replace(/\S+$/u, '');
        this.updateTextPrompt({ value: before + this.interactivePrompt.value.slice(this.interactivePrompt.cursor), cursor: before.length });
      } else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killWordBackward();
        this.refreshInputCompletion();
      }
    });
    // Undo / kill-ring yank, ported from minimax-code's editor. C-z is safe
    // to bind: blessed reads the terminal in raw mode, so the SUSP character
    // never reaches the tty line discipline to suspend the process.
    target.key(['C-z'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.undo();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-y'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.yank();
        this.refreshInputCompletion();
      }
    });
    target.key(['M-y'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.yankPop();
        this.refreshInputCompletion();
      }
    });
    // Rebindable global actions, dispatched from the action table with this
    // session's overrides applied. The editor and completion keys stay on
    // their fixed bindings: their routing is priority-ordered, not flat.
    this.bindAction('clear', () => {
      if (this.interactivePrompt === null) this.clearTranscript();
    });
    this.bindAction('expand-all', () => {
      if (this.interactivePrompt !== null) return;
      this.expanded = !this.expanded;
      this.expandedBlockIds.clear();
      this.collapsedBlockIds.clear();
      this.scheduler.requestImmediate();
    });
    this.bindAction('follow-tail', () => { if (this.interactivePrompt === null) this.followTail(); });
    this.bindAction('focus', () => { if (this.interactivePrompt === null) this.toggleFocus(); });
    this.bindAction('help', () => { this.toggleWindow('help'); });
    this.bindAction('history', () => { this.toggleWindow('history'); });
    this.bindAction('usage', () => { this.toggleWindow('usage'); });

    // Ctrl+C is deliberately NOT rebindable: it is the interrupt-and-exit
    // channel, and a config file that moved it could lock a user out of the
    // process. It stays bound above, verbatim.

    // ── Mouse wheel ─────────────────────────────────────────────────────
    // With mouse reporting ENABLED the terminal ships the wheel as SGR mouse
    // sequences, which blessed parses into `mouse` events — and which
    // therefore never reach the key path as synthesized ↑/↓. That is the
    // whole point: without it, terminals like Warp translate the wheel into
    // arrow keys, and the arrows in input focus recall HISTORY, so the wheel
    // could never scroll the transcript at all. Only the wheel is consumed:
    // clicks stay with the terminal, so text selection keeps working.
    this.program.enableMouse();
    this.program.on('mouse', (key: { action?: string }) => {
      const action = key?.action;
      if (action !== 'wheelup' && action !== 'wheeldown') return;
      if (this.interactivePrompt !== null || this.overlay.isActive) return;
      if (this.windowMgr.isActive) {
        this.windowMgr.handleKey(action === 'wheelup' ? 'up' : 'down');
        this.scheduler.requestImmediate();
        return;
      }
      this.scrollByLines(action === 'wheelup' ? -WHEEL_STEP_LINES : WHEEL_STEP_LINES);
    });
    target.key(['left'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.cursor - 1);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'transcript') this.setSelectedBlockExpanded(false);
      else if (this.interactivePrompt === null) {
        this.editor.moveLeft();
        if (this.focus === 'input') this.refreshInputCompletion();
      }
    });
    target.key(['right'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.cursor + 1);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'transcript') this.setSelectedBlockExpanded(true);
      else if (this.interactivePrompt === null) {
        this.editor.moveRight();
        if (this.focus === 'input') this.refreshInputCompletion();
      }
    });
    target.key(['C-left'], () => {
      if (this.interactivePrompt === null && !this.swallowForWindow() && this.focus === 'input') {
        this.editor.moveWordLeft();
        this.refreshInputCompletion();
      }
    });
    target.key(['C-right'], () => {
      if (this.interactivePrompt === null && !this.swallowForWindow() && this.focus === 'input') {
        this.editor.moveWordRight();
        this.refreshInputCompletion();
      }
    });
    target.key(['home'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(0);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveHome();
        this.refreshInputCompletion();
      }
    });
    target.key(['end'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.value.length);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveEnd();
        this.refreshInputCompletion();
      }
    });
    target.key(['backspace'], () => {
      // The overlay outranks the editor: the questionnaire's notes buffer is a
      // real text field, so a backspace under the modal must edit notes and
      // never the prompt underneath (the same rule the keypress path applies).
      if (this.overlay.isActive) {
        this.overlay.handleKey({ name: 'backspace' });
        this.scheduler.requestImmediate();
      } else if (this.interactivePrompt?.kind === 'text') this.backspacePrompt();
      else if (this.windowMgr.isActive) {
        this.windowMgr.handleKey('backspace');
        this.scheduler.requestImmediate();
      } else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.backspace();
        this.refreshInputCompletion();
      }
    });
    target.key(['delete'], () => {
      if (this.interactivePrompt?.kind === 'text') this.deletePromptForward();
      else if (this.windowMgr.isActive) {
        // Forward delete means nothing to a filter; swallow it so it cannot
        // reach the editor underneath the modal.
        this.scheduler.requestImmediate();
      } else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.deleteForward();
        this.refreshInputCompletion();
      }
    });

    // ── Keys the completion popup and the editor CONTEND for ─────────────
    //
    // Exactly ONE blessed name per physical key, and never both names of a
    // pair.
    //
    // `Screen.prototype.key` forwards to `program.key`, which registers on the
    // PROGRAM emitter (`widgets/screen.js:1726` → `program.js:515-520`).
    // `Program._listenInput` broadcasts `key <name>` once per `input` keypress
    // (`program.js:408-412`) — but `\r` produces TWO `input` keypresses, because
    // lines 397-399 re-emit the key under the alias `enter` and then fall
    // through for the real `return`. So one physical Enter fires `key enter`
    // once and `key return` once.
    //
    // Binding both names therefore dispatches twice. Measured consequence with
    // the popup open on `/rev`: the first run accepted `/review `, the second
    // found the popup already closed and fell through to `onEnter()`, which
    // appended a newline to the text it had just accepted. The completion
    // controller's own tests could not have seen it — they dispatch once.
    //
    // Binding only the canonical name drops the duplicate by construction: no
    // dedup state, and no assumption about how fast the two arrivals land.
    for (const [name, completionKey] of Object.entries(TUIApp.CONTENDED_BINDINGS)) {
      target.key([name], () => {
        this.routeContended(completionKey);
      });
    }

    target.key(['pageup'], () => {
      if (this.interactivePrompt === null && this.windowMgr.isActive) {
        this.windowMgr.handleKey('pageup');
        this.scheduler.requestImmediate();
        return;
      }
      if (this.interactivePrompt === null) this.scrollBy(-1);
    });
    target.key(['pagedown'], () => {
      if (this.interactivePrompt === null && this.windowMgr.isActive) {
        this.windowMgr.handleKey('pagedown');
        this.scheduler.requestImmediate();
        return;
      }
      if (this.interactivePrompt === null) this.scrollBy(1);
    });

    // Everything else is text. Notably this is where CJK arrives: measured on
    // blessed's key path a committed ideograph arrives with `key.name`
    // undefined and `ch` holding the character, so the name-keyed bindings
    // above never see it and it lands here instead.
    target.on('keypress', (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      const name = key?.name;

      // The popup's keys are bound on the program channel above, so this path
      // must not also read them as input. `enter` is in this set without being
      // bound: it is the duplicate blessed re-emits for every physical Enter.
      if (typeof name === 'string' && TUIApp.CONTENDED_ALIASES.has(name)) {
        this.scheduler.requestImmediate();
        return;
      }

      if (typeof name === 'string' && TUIApp.SPECIAL_KEYS.has(name)) {
        this.scheduler.requestImmediate();
        return;
      }
      if (typeof name === 'string' && name.length > 1 && name !== 'space') {
        this.scheduler.requestImmediate();
        return;
      }
      if (typeof ch !== 'string' || ch.length === 0) return;
      if (this.interactivePrompt !== null) {
        this.handleInteractivePromptCharacter(ch);
        return;
      }
      if (this.windowMgr.isActive) {
        // Filterable windows take typing; static ones swallow it so it cannot
        // land in the prompt underneath the modal.
        this.windowMgr.feedCharacter(ch);
        this.scheduler.requestImmediate();
        return;
      }
      if (this.overlay.isActive) {
        // The overlay answers with single keys; they must not also land in
        // the prompt underneath it.
        this.handleOverlayKey(ch, key);
        return;
      }
      if (this.focus === 'transcript') this.focus = 'input';
      this.editor.insert(ch);
      this.paste.feed(ch, now());
      this.refreshCompletion();
      this.scheduler.requestImmediate();
    });
  }

  /**
   * Give a contended key to the popup, or to its editor meaning.
   *
   * Refresh completion after input changes and whenever focus returns to the
   * editor. Transcript navigation has no effect on the input or its candidates.
   *
   * ## Why this takes no key identity
   *
   * blessed delivers ONE physical Enter TWICE, under two names. It is not a
   * timing artefact to be filtered here: `CONTENDED_BINDINGS` binds only the
   * name a terminal really sends (`return`), so the duplicate alias (`enter`)
   * never reaches this function at all. Routing one name per physical key
   * upstream is what makes this dispatch safe — see the note in `bindKeys`.
   */
  private routeContended(key: CompletionKey): void {
    if (this.interactivePrompt !== null) {
      this.handleInteractivePromptKey(key);
      this.scheduler.requestImmediate();
      return;
    }

    // The permission picker outranks windows and the editor: the navigation
    // keys choose a row, Enter confirms, Esc cancels.
    if (this.overlay.isActive) {
      this.overlay.handleKey({ name: key });
      this.scheduler.requestImmediate();
      return;
    }

    // A modal window takes the navigation keys while it is open. `tab` means
    // nothing in a window and is swallowed rather than delivered to the
    // editor underneath.
    if (this.windowMgr.isActive) {
      this.windowMgr.handleKey(key);
      this.scheduler.requestImmediate();
      return;
    }

    const fallbacks: Record<CompletionKey, () => void> = {
      up: () => {
        if (this.focus === 'transcript') this.moveSelectedBlock(-1);
        else this.editor.historyPrevious();
      },
      down: () => {
        if (this.focus === 'transcript') this.moveSelectedBlock(1);
        else this.editor.historyNext();
      },
      tab: () => {
        if (this.focus === 'transcript' || this.editor.isEmpty) this.toggleFocus();
        else this.editor.insert('  ');
      },
      escape: () => {
        if (this.focus === 'transcript') this.focus = 'input';
        else if (this.completion.isOpen) this.completion.close();
        else if (this.options.isBusy?.() ?? this.busy) this.options.onInterrupt?.();
        else if (this.editor.isEmpty) {
          const queued = this.options.onRecallQueued?.();
          if (queued != null) this.editor.setText(queued, Array.from(queued).length);
        }
        else this.closeOverlay();
      },
      return: () => {
        if (this.focus === 'transcript') this.focus = 'input';
        else this.onEnter();
      },
    };

    const selectingSlashOption = this.completion.snapshot.argumentCommand !== undefined;
    const result = this.completion.handleKey(key, this.editor.text);
    if (result.accepted !== null) {
      this.editor.setText(result.accepted.text, result.accepted.cursor);
      if (result.submitAfterAccept) {
        this.onEnter(true);
        return;
      }
      if (selectingSlashOption && key === 'tab') this.paste.reset();
      this.refreshCompletion();
      this.scheduler.requestImmediate();
      return;
    }
    if (result.consumed) {
      this.refreshCompletion();
      this.scheduler.requestImmediate();
      return;
    }
    fallbacks[key]();
    if (this.focus === 'input') this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  private handleInteractivePromptKey(key: CompletionKey): void {
    const prompt = this.interactivePrompt;
    if (prompt === null) return;
    if (key === 'escape') {
      this.settleInteractivePrompt(null);
      return;
    }
    if (key === 'return') {
      this.settleInteractivePrompt(prompt.kind === 'select'
        ? prompt.choices[prompt.selectedIndex]?.value ?? null
        : prompt.value);
      return;
    }
    if (prompt.kind === 'select' && (key === 'up' || key === 'down')) {
      const delta = key === 'up' ? -1 : 1;
      const selectedIndex = (prompt.selectedIndex + delta + prompt.choices.length) % prompt.choices.length;
      this.interactivePrompt = { ...prompt, selectedIndex };
    }
  }

  private handleInteractivePromptCharacter(ch: string): void {
    const prompt = this.interactivePrompt;
    if (prompt?.kind !== 'text') return;
    const input = ch.replace(/[\r\n\0]/gu, '');
    if (input === '') return;
    this.updateTextPrompt({
      value: prompt.value.slice(0, prompt.cursor) + input + prompt.value.slice(prompt.cursor),
      cursor: prompt.cursor + input.length,
    });
  }

  private handleBracketedPaste(text: string): void {
    if (text.length === 0) return;
    if (this.interactivePrompt !== null) {
      this.handleInteractivePromptCharacter(text);
      this.scheduler.requestImmediate();
      return;
    }
    if (this.windowMgr.isActive) {
      for (const character of text) this.windowMgr.feedCharacter(character);
      this.scheduler.requestImmediate();
      return;
    }
    // A paste must never accidentally answer a permission prompt.
    if (this.overlay.isActive) return;
    if (this.focus === 'transcript') this.focus = 'input';
    this.editor.insert(text);
    // Bracketed paste already tells us exactly where the payload ends, so its
    // embedded newlines are literal and must not arm the burst Enter heuristic.
    this.paste.reset();
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  private movePromptCursor(cursor: number): void {
    const prompt = this.interactivePrompt;
    if (prompt?.kind !== 'text') return;
    this.updateTextPrompt({ cursor: Math.max(0, Math.min(prompt.value.length, cursor)) });
  }

  private updateTextPrompt(patch: { value?: string; cursor?: number }): void {
    const prompt = this.interactivePrompt;
    if (prompt?.kind !== 'text') return;
    const value = patch.value ?? prompt.value;
    this.interactivePrompt = {
      ...prompt,
      value,
      cursor: Math.max(0, Math.min(value.length, patch.cursor ?? prompt.cursor)),
    };
    this.scheduler.requestImmediate();
  }

  private backspacePrompt(): void {
    const prompt = this.interactivePrompt;
    if (prompt?.kind !== 'text' || prompt.cursor === 0) return;
    this.updateTextPrompt({
      value: prompt.value.slice(0, prompt.cursor - 1) + prompt.value.slice(prompt.cursor),
      cursor: prompt.cursor - 1,
    });
  }

  private deletePromptForward(): void {
    const prompt = this.interactivePrompt;
    if (prompt?.kind !== 'text' || prompt.cursor >= prompt.value.length) return;
    this.updateTextPrompt({
      value: prompt.value.slice(0, prompt.cursor) + prompt.value.slice(prompt.cursor + 1),
    });
  }

  /**
   * Recompute the popup from the current input and caret.
   *
   * Called from EVERY place the input text can change — typed characters, an
   * accept, a backspace, a history recall — because the popup is a function of
   * both. A trigger that only updated on typing would keep offering rows for
   * text the user has since deleted.
   */
  private refreshCompletion(): void {
    this.completion.update(this.editor.text, this.editor.cursor);
  }

  /** Keep the popup in sync with editor mutations and caret movement. */
  private refreshInputCompletion(): void {
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  private handleOverlayKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    // The picker owns its own key semantics (y/a/n, 1-3, arrows, Enter,
    // Esc); unhandled keys are swallowed here so they cannot reach the
    // prompt underneath the modal.
    this.overlay.handleKey({ name: key?.name, ch });
    this.scheduler.requestImmediate();
  }

  private onEnter(fromSlashOption = false): void {
    if (this.overlay.isActive) {
      // Enter belongs to the overlay — it arrives through the contended-key
      // route, where the picker confirms and the questionnaire commits. It
      // must NOT fall through to the prompt: submitting under a modal would
      // start a run the user cannot see.
      this.scheduler.requestImmediate();
      return;
    }
    if (this.options.canSubmit?.() === false) return;
    const at = now();
    if (!fromSlashOption && this.paste.isPastedEnter(at)) {
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
    this.refreshCompletion();
    if (this.options.echoSubmitted !== false) {
      this.model.addUser(text);
      this.noteTranscriptMutation();
    }
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
    if (this.focus === 'transcript') this.focus = 'input';
    this.follow = true;
    this.scrollLines = 0;
    this.scheduler.requestImmediate();
  }

  private toggleFocus(): void {
    if (this.focus === 'input') {
      this.focus = 'transcript';
      this.completion.close();
      this.selectedBlockIndex = this.model.blocks.length - 1;
      this.revealSelectedBlock();
    } else {
      this.focus = 'input';
      this.refreshCompletion();
    }
    this.scheduler.requestImmediate();
  }

  private moveSelectedBlock(delta: number): void {
    const count = this.model.blocks.length;
    if (count === 0) return;
    const current = this.selectedBlockIndex < 0 ? count - 1 : this.selectedBlockIndex;
    this.selectedBlockIndex = Math.max(0, Math.min(count - 1, current + delta));
    this.revealSelectedBlock();
    this.scheduler.requestImmediate();
  }

  private setSelectedBlockExpanded(expanded: boolean): void {
    const block = this.model.blocks[this.selectedBlockIndex];
    if (block === undefined) return;
    const hasDetails = block.kind === 'thinking' ||
      (block.kind === 'tool' && block.result !== undefined && block.result.trim() !== '');
    if (!hasDetails) return;

    this.expandedBlockIds.delete(block.id);
    this.collapsedBlockIds.delete(block.id);
    if (expanded) this.expandedBlockIds.add(block.id);
    else this.collapsedBlockIds.add(block.id);
    this.revealSelectedBlock();
    this.scheduler.requestImmediate();
  }

  private revealSelectedBlock(): void {
    const blocks = this.model.blocks;
    const selected = blocks[this.selectedBlockIndex];
    if (selected === undefined) return;

    const options = this.renderOptions();
    // Heights come from the same cache the paint path reads, so the window
    // arithmetic here can never disagree with what is on screen. Blocks are
    // joined with '\n', and a stanza gap is the FIRST line of the block below
    // it, so a block's start line is the plain sum of the heights before it —
    // no per-block +1.
    const heights = this.transcript.heights(this.model, options);
    let selectedStart = 0;
    for (let index = 0; index < this.selectedBlockIndex; index += 1) {
      selectedStart += heights[index] ?? 0;
    }

    const selectedRows = heights[this.selectedBlockIndex] ?? 0;
    const totalRows = heights.reduce((total, lines) => total + lines, 0);
    const viewportRows = this.visibleTranscriptRows();
    const maxStart = Math.max(0, totalRows - viewportRows);
    let start = Math.max(0, Math.min(maxStart, maxStart - this.scrollLines));
    if (selectedStart < start) start = selectedStart;
    else if (selectedStart + selectedRows > start + viewportRows) {
      start = selectedStart + selectedRows - viewportRows;
    }
    start = Math.max(0, Math.min(maxStart, start));
    this.scrollLines = maxStart - start;
    this.follow = this.scrollLines === 0;
  }

  private scrollBy(pages: number): void {
    const rows = this.visibleTranscriptRows();
    const total = this.transcript.totalLines(this.model, this.renderOptions());
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

  /**
   * Line-granular scroll for the wheel: a page per tick is far too coarse
   * when one tick arrives per finger movement. Same follow semantics as
   * `scrollBy` — reaching the newest line resumes following.
   */
  private scrollByLines(lines: number): void {
    const total = this.transcript.totalLines(this.model, this.renderOptions());
    const maxBack = Math.max(0, total - this.visibleTranscriptRows());
    this.scrollLines = lines < 0
      ? Math.min(maxBack, this.scrollLines - lines)
      : Math.max(0, this.scrollLines - lines);
    this.follow = this.scrollLines === 0;
    this.scheduler.requestImmediate();
  }

  // ------------------------------------------------------------------ plumbing

  private bindPaste(): void {
    // The own input path consumes bracketed-paste markers and routes the
    // payload as one literal edit. Blessed drops the markers and its burst
    // detector continues to protect unbracketed paste delivery.
  }

  private bindResize(): void {
    this.writer.on('resize', () => {
      this.scheduler.requestImmediate();
    });
  }
}

function now(): number {
  return performance.now();
}

/** Human token count: `940`, `12.3k`, `1.2M`. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
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

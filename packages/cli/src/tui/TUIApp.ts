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

import {
  cursorTo,
  disableBracketedPaste,
  disableMouseReporting,
  enableBracketedPaste,
  enableMouseReporting,
  hideCursor,
  showCursor,
} from './terminal/ansi.js';
import {
  createScreenSurface,
  selectScreenRenderer,
  type RegionMetrics,
  type ScreenRenderer,
  type ScreenSurface,
} from './screen/index.js';
import { frameRecord, frameString, TranscriptModel, readBlockKey, type LegacyFrame, type Block } from './blocks.js';
import { ActivityTracker } from './components/activity.js';
import { TranscriptPane } from './components/transcript-pane.js';
import { DeltaBuffer, DEFAULT_STALE_MS } from './delta-buffer.js';
import { RenderScheduler } from './render-scheduler.js';
import { Pacer } from './pacer.js';
import { PasteBurstDetector } from './paste-burst.js';
import { InputEditor } from './editor.js';
import { OverlayState, isDestructiveRequest, type PermissionDecision, type QuestionAnswers } from './overlay.js';
import { DEFAULT_RENDER_OPTIONS, escapeTags, stylesOf, type RenderOptions } from './transcript-view.js';
import { TranscriptRenderer } from './transcript-cache.js';
import type { EscapeSafeWriter } from './bounded-writer.js';
import { TerminalSession } from './terminal/session.js';
import {
  createInputDriver,
  type InputEvent,
  type InputMouseEvent,
  type NormalizedKey,
  type TerminalInputDriver,
} from './terminal/input-driver.js';
import { popKittyKeyboardFlags, pushKittyKeyboardFlags } from './terminal/ansi.js';
import { buildComposerLayout } from './composer-layout.js';
import { wrapWithCursor, type WrappedText } from './width.js';
import { CompletionController, type CompletionKey, type CompletionSources } from './completion.js';
import {
  RichPanelController,
  WindowManager,
  type ListSection,
  type RichPanelSpec,
  type RichPanelTab,
  type WindowItem,
} from './window.js';
import { ACTION_DEFS, helpGroups, KEYMAP_HEADINGS, keysColumn, type ActionDef } from './actions.js';
import { applyKeyOverrides, loadKeyOverrides, toBlessedKeys, REBINDABLE_ACTIONS, validateKeyOverrides, type KeymapIssue } from './keymap.js';
import { resolveThemeName, themeFor, type ThemeName, effortBorderColor, effortBorderTag, normalizeEffort, type EffortLevel } from './theme.js';
import { compactActivity } from './text.js';
import { buildFooterLines, formatTokensPerSecond, readGitBranch } from './footer.js';
import { resolveStatusLabel } from './status-label.js';
import { detectTerminalEnvironment, type TerminalEnvironment } from './terminal-env.js';
import {
  backgroundSummarySuffix,
  nextSpinnerFrame,
  spinnerGlyph,
  workingTailLine,
  WORKING_TAIL_INTERVAL_MS,
} from './working-tail.js';
import { InlineSurface } from './terminal/surface.js';
import { conversationRegionBottom, type TerminalSize } from './terminal/viewport.js';
import { BackgroundTaskModel, formatTaskDuration, taskStatusGlyph, type BackgroundTaskGroup, type BackgroundTaskRow, type BackgroundTaskView } from './background-tasks.js';
import type { BackgroundTaskListV1 } from '@duya/agent-protocol';
import type { Message as TranscriptMessage, MessageContent } from '@duya/agent-protocol/transcript';
import type { FileAttachment } from '@duya/agent-protocol';
import type { CommandLocale } from '@duya/command-catalog';
import { calculateOutputTokensPerSecond } from '@duya/ai';
import {
  attachmentChipLabel,
  extractPathPasteCandidate,
  findAttachmentLimitViolation,
  resolveClipboardFileAttachment,
  resolvePathAttachment,
  takeAttachmentsForSubmit,
  type TuiDraftAttachment,
} from './attachments.js';
import { disposeClipboardTempDir, readClipboardAttachments } from './clipboard-image.js';

/** DECSET 2026: begin synchronized update. */
const SYNC_BEGIN = '\x1b[?2026h';
/** DECRST 2026: end synchronized update. */
const SYNC_END = '\x1b[?2026l';

/** Lines the input box may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 8;

/** Height of the full-screen status bar, in rows. */
const STATUS_ROWS = 1;

/**
 * Footer rows in inline mode.
 *
 * Two, like pi: the path row and the stats/model row. Inline mode is the
 * default and the pi-aligned presentation, so it gets the footer that carries
 * the same information in the same two places. Full-screen mode keeps its
 * single status row — it is a fixed window with a bordered transcript, and
 * spending another row on chrome there costs the conversation directly.
 */
const INLINE_FOOTER_ROWS = 2;

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

/**
 * Draft rows the queue preview shows above the composer. The block is chrome
 * in inline mode — every row it gains pushes the composer down — so it is a
 * fixed budget rather than "whatever is pending".
 */
const QUEUE_PREVIEW_ROWS = 3;

/**
 * Slash and bang lines belong to the controller, not to the running turn.
 *
 * `/queue` must open its panel and `!git status` must run here even while a run
 * is live, so the busy-time keys route these through the ordinary submit path
 * instead of turning them into steering guidance.
 */
function isControllerLine(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('/') || head.startsWith('!');
}

/**
 * How long a git branch read is reused.
 *
 * The footer repaints per frame; a checkout is a human action measured in
 * seconds. Two seconds is short enough that `git switch` shows up while the
 * user is still looking at the line and long enough that a streaming turn does
 * not stat `.git` sixty times a second.
 */
const GIT_BRANCH_TTL_MS = 2000;

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


/** A row in a keyboard-driven modal picker. */
export interface TuiChoice {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

/** One pending draft as the queue preview paints it. */
export interface QueuedDraftView {
  readonly text: string;
  readonly mode: 'steer' | 'queue';
}

/** One row of a live settings list: a name, its current value, and what it does. */
export interface TuiSettingsRow {
  /** Stable identity: `onActivate` is called with it, not with the label. */
  readonly id: string;
  readonly label: string;
  /** Right-hand column, e.g. `Dark`, `8 rows`, `Shown`. */
  readonly valueLabel: string;
  /** Explanation for the selected row, shown under the list. */
  readonly detail?: string;
}

type InteractivePrompt =
  | { kind: 'select'; title: string; choices: readonly TuiChoice[]; selectedIndex: number }
  | { kind: 'text'; title: string; value: string; cursor: number; secret: boolean; placeholder: string };

/**
 * The live handle on a rich panel a command opened.
 *
 * A panel's row actions mutate state outside the TUI — installing a plugin,
 * adding a provider — so the command has to push re-read rows back in, and
 * the dock holds exactly one panel, so the handle is passed to `onOpen` rather
 * than returned. Only the parts a command needs are exposed; navigation stays
 * the controller's.
 */
export interface RichPanelHandle {
  /** Replace one tab's rows, keeping the cursor on the row with the same value. */
  syncTab(tabId: string, section: ListSection): void;
  activeTabId(): string | undefined;
  /** The selected row of the active tab, for a detail page or a confirmation. */
  activeSelectedValue(): string | undefined;
  /** Leave the panel — fires its `onClose` like Esc from the tab strip does. */
  close(): void;
}

const PROMPT_VISIBLE_CHOICES = 9;

/**
 * What the renderer was built from.
 *
 * Published on the writer, so a test can assert the terminal's capabilities
 * actually reached the renderer rather than trusting that a constant stayed
 * correct. With no library in between, this IS the whole configuration: the
 * three facts the old `blessed.program`/`blessed.screen` pair carried.
 */
export interface RenderConfig {
  readonly terminal: string;
  /** 16 for truecolor (blessed's own convention), otherwise an ANSI depth. */
  readonly colors: number;
  readonly unicode: boolean;
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
  /**
   * Called with each submitted prompt. `attachments` carries the files whose
   * chip labels survived in the submitted text (see `attachments.ts`); it is
   * empty for the common no-attachment prompt.
   */
  readonly onSubmit: (text: string, attachments: readonly FileAttachment[]) => void | Promise<void>;
  /** Let the controller own accepted-message echo and pending drafts. */
  readonly echoSubmitted?: boolean;
  readonly canSubmit?: () => boolean;
  /**
   * Pending drafts with their intended delivery, so the preview can tell a
   * steer (consumed by the running turn) from a fresh turn.
   */
  readonly queuedDrafts?: () => readonly QueuedDraftView[];
  readonly queuePaused?: () => boolean;
  readonly onRecallQueued?: () => string | null;
  /**
   * The next prompt the worker predicted for the last turn.
   *
   * It is drawn as the composer's placeholder while the editor is empty, and
   * Enter on an empty composer adopts it into the editor.
   */
  readonly turnSuggestion?: () => string | null;
  /**
   * Enter while a turn runs: inject the draft into that turn.
   *
   * `attachments` carries the same files `onSubmit` receives; a draft is one
   * thing the user sent, so whichever way it travels it keeps its files.
   */
  readonly onSteer?: (text: string, attachments: readonly FileAttachment[]) => void | Promise<void>;
  /** Tab while a turn runs: hold the draft for the next turn. */
  readonly onQueueDraft?: (text: string, attachments: readonly FileAttachment[]) => void | Promise<void>;
  /** Esc while a turn runs and the draft is not empty: stop, then send it. */
  readonly onInterruptAndSend?: (text: string, attachments: readonly FileAttachment[]) => void;
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
   * exits, which a fixed window cannot offer. This is the default (see
   * `DEFAULT_TUI_PREFERENCES`) and the shape pi uses: a docked composer and
   * footer at the bottom of the page, the conversation above them in ordinary
   * scrollback. `DUYA_TUI_INLINE=0` turns it off.
   *
   * In this mode blessed's `Screen` is never constructed — it switches to the
   * alternate buffer in its constructor, and an alternate buffer has no
   * scrollback to commit into. Its `Program` is still used, for input only.
   */
  readonly inline?: boolean;
  /**
   * Directory the footer's first row shows. Defaults to `process.cwd()`.
   *
   * A callback rather than a string because a session can move (a resume into
   * another workspace), and the footer must describe the session that is
   * running, not the one that was launched.
   */
  readonly workspaceDirectory?: () => string;
  /**
   * Model identity for the footer's right-hand column.
   *
   * The TUI does not know what model a Host session is running — that lives in
   * the session record — so the wiring reports it, exactly as it already does
   * for `statusText`.
   */
  readonly modelLabel?: () => { provider?: string; model: string; thinking?: string };
  /** Session name for the footer's path row, when the caller has one. */
  readonly sessionName?: () => string | null;
  /**
   * Reasoning effort for the NEXT turn, as a string (`'low'`, `'high'`, …).
   *
   * Drives the composer's border colour — pi's tell for "how much thinking am
   * I about to pay for". A callback, not a value: `/effort` changes it while
   * the app is running, and the next repaint has to see the new level.
   *
   * When this returns null the last run's own effort (from `turn_start`) is
   * used instead, so a Host that decides effort itself still gets a colour.
   */
  readonly effort?: () => string | null;
  /**
   * Called when `/settings` (or `/effort`) moves the effort level itself, so
   * the chat loop can adopt it for the next run.
   *
   * The border colour is the TUI's; the value a run is started with is not.
   * The loop owns that variable, and this is how a menu row that says `high`
   * ends up sending `effort: 'high'` rather than merely painting a border.
   */
  readonly onEffortChange?: (effort: string | null) => void;
  /** Shared Desktop/TUI language preference; slash descriptions update live. */
  readonly onLocaleChange?: (locale: CommandLocale) => void;
  /** Thinking blocks in the transcript. `/settings` can flip this live. */
  readonly showThinking?: boolean;
  /** Show tool result bodies without per-block expansion. */
  readonly showToolResults?: boolean;
  /** Start with every block expanded — the saved state of the expand key. */
  readonly expandBlocks?: boolean;
  /**
   * Rows the input box may grow to before it scrolls internally.
   *
   * Named `maxInputRows` because `inputRows` already means something else
   * inside the app: how many rows the box is showing right now.
   */
  readonly maxInputRows?: number;
  /**
   * Ask the wiring for a fresh background-bash snapshot.
   *
   * The TUI cannot read the Host itself; opening the task view is the one
   * moment it needs a reading the poller may have stopped making.
   */
  readonly onBackgroundTasksRefresh?: () => void;
  /**
   * Open one task's detail. The wiring reads the output tail (an I/O it owns)
   * and calls `showPanel`; the TUI only knows what it has already seen.
   */
  readonly onBackgroundTaskOpen?: (task: BackgroundTaskView) => void;
}

/**
 * The preferences `/settings` can move without a restart.
 *
 * Deliberately a subset of `TuiPreferences`: theme and display mode rebuild the
 * surface, so they stay restart-only and are labelled as such in the menu.
 * Everything here is a field the next repaint reads.
 */
export interface TuiLivePreferences {
  readonly effort?: string | null;
  readonly locale?: CommandLocale;
  /**
   * `null` means "follow the environment", which is what the `system` setting
   * row means; the renderer re-probes rather than holding a resolved name.
   */
  readonly theme?: ThemeName | null;
  readonly showThinking?: boolean;
  readonly expandBlocks?: boolean;
  readonly showToolResults?: boolean;
  readonly completionRows?: number;
  readonly inputRows?: number;
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
  /**
   * Own-renderer input. null on the blessed path, which keeps parsing input
   * through blessed's own `Program` — the rollback switch has to roll back the
   * input path too, or "roll back" would mean "run blessed's painter on our
   * parser", a combination neither side was tested for.
   */
  private readonly inputDriver: TerminalInputDriver | null;
  /**
   * `key <full>` handlers, keyed by blessed-compatible name.
   *
   * A LIST per name, not a single handler, because blessed fires every listener
   * registered for a name and the app has at least one case where that is
   * deliberate (the same action reachable from two chords). Collapsing to one
   * would silently drop a binding.
   */
  private readonly keyHandlers = new Map<string, (() => void)[]>();
  /** The catch-all for keys no binding claimed, mirroring `keypress`. */
  private keypressHandler: ((ch: string, key: NormalizedKey) => void) | null = null;
  /** Mouse reports, when the surface wants them. */
  private mouseHandler: ((event: InputMouseEvent) => void) | null = null;
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
  /** Rows the popup shows. Mutable: `/settings` resizes it while running. */
  private completionRows: number;

  private readonly model = new TranscriptModel();
  private readonly editor = new InputEditor();
  private readonly overlay = new OverlayState();
  /** Permission events and Host polling can report the same pending ask. */
  private readonly permissionRequestIds = new Set<string>();
  /** Login/provider wizard prompt. Values never pass through the chat editor. */
  private interactivePrompt: InteractivePrompt | null = null;
  private interactivePromptResolver: ((value: string | null) => void) | null = null;
  /** The tabbed panel currently owning the dock, if any (630a). */
  private activeRichPanel: RichPanelController | null = null;
  private readonly scheduler: RenderScheduler;

  /** Per stream: assistant text and thinking text get their own buffers. */
  private readonly textBuffer = new DeltaBuffer();
  private readonly thinkingBuffer = new DeltaBuffer();
  private deltaDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pacer = new Pacer();
  private readonly paste = new PasteBurstDetector();
  /**
   * Attachments queued for the NEXT submission, each standing in the editor
   * buffer through its chip `label`. Plain-text labels over interval mapping:
   * the editor stays a text buffer, and an attachment whose label was edited
   * or deleted away simply does not appear in the submitted text, which is
   * exactly the "delete the chip to drop the attachment" semantic.
   */
  private draftAttachments: TuiDraftAttachment[] = [];
  /** Counter for chip labels; grows for the session, never resets on submit. */
  private chipSeq = 0;
  /** Counter for local `!` shell cards. */
  private localShellSeq = 0;

  /** Transcript-wide expansion; the same flag `/settings` calls expand blocks. */
  private expanded: boolean;
  /** Thinking blocks in the transcript. Off removes them from the plan. */
  private showThinking: boolean;
  /** Tool result bodies, independent of `expanded` (which also opens them). */
  private showToolResults: boolean;
  /**
   * Rows the input box may GROW to.
   *
   * Not `inputRows`, which is how many rows it is showing right now and which
   * the layout arithmetic subtracts from the screen — that one is measured,
   * this one is a ceiling the user sets.
   */
  private maxInputRows: number;
  private focus: 'input' | 'tasks' = 'input';
  /** Selected row in the task view, over `backgroundTaskRows()`. */
  private selectedTaskRow = -1;
  /** Tail-following. Disengaged by scrolling up, restored by Ctrl+End. */
  private follow = true;
  /**
   * Where the top of the viewport sits, in lines from the top of the document.
   *
   * ABSOLUTE, not "how many lines back from the tail". An absolute offset
   * anchors the viewport to the CONTENT: a message that arrives while the
   * reader is scrolled up appears below what they are reading instead of
   * pushing it off the top of the screen. A tail-relative offset moved the
   * window along with the newest line, which is what made the transcript
   * slide away under a reader who had scrolled up to look at something.
   *
   * Only meaningful while `follow` is false; while following, the window is
   * pinned to the newest line.
   */
  private scrollTop = 0;
  /**
   * Cache-fed transcript renderer. Every paint asks it for the window slice;
   * unchanged blocks come back as cached line arrays, so a streaming frame
   * re-renders only the block that actually changed.
   */
  private readonly transcript = new TranscriptRenderer();
  /**
   * The transcript as a retained component.
   *
   * It owns the assembled-document cache and the windowing query, which used to
   * be a pair of fields here plus arithmetic repeated in `paintTranscript`. The
   * props are reassigned each frame; nothing else about it is per-frame state.
   */
  private readonly transcriptPane = new TranscriptPane({
    renderer: this.transcript,
    model: this.model,
    options: DEFAULT_RENDER_OPTIONS,
    scrollTop: 0,
    following: true,
  });
  /** Bumped on any private model change the options key cannot observe. */
  private transcriptRevision = 0;
  private lastCtrlCAt = Number.NEGATIVE_INFINITY;
  private running = false;
  /** Lines committed to the model but not yet accounted for by a render. */
  private queuedLines = 0;
  private oldestQueuedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  /**
   * Who is doing what, right now. Owns the run-fact state machine; this class
   * only decides when to repaint it (plan 615 Phase 6).
   */
  private readonly activity = new ActivityTracker();
  /**
   * Background bash (polled from the Host) and subagents (from the run's own
   * frames), merged for the summary line and the task view. Completed entries
   * stay until the session is left so they can still be inspected.
   */
  private readonly backgroundTasks = new BackgroundTaskModel();

  /**
   * Whether a modal owns the input. Stored on the tracker (it decides the label)
   * and re-exposed here so the twenty call sites that ask the TUI stay readable.
   */
  private get waitingForPermission(): boolean {
    return this.activity.waitingForPermission;
  }

  private set waitingForPermission(value: boolean) {
    this.activity.waitingForPermission = value;
  }
  /**
   * The working tail's spinner.
   *
   * Chrome, never transcript — see `working-tail.ts` for why a row the surface
   * rewrites is the only kind of row that can hold a spinner.
   */
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  /** Modal windows (F1 help, Ctrl+R history, Ctrl+P usage). */
  private readonly windowMgr = new WindowManager(() => this.scheduler.requestImmediate());
  /** Palette for the transcript and the windows. Assigned in the constructor. */
  /**
   * Mutable because `/settings` changes it in place.
   *
   * Every read of it goes through this field rather than through a value
   * captured at construction, which is the whole reason a theme switch can be
   * immediate: the palette is looked up per paint, not baked into the first
   * one. `display-mode` cannot work this way — inline vs full screen decides
   * which surface object exists — so that row stays a restart.
   */
  private theme: ReturnType<typeof themeFor>;
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
  private lastUsage: {
    input: number;
    output: number;
    total: number;
    /** Output tokens per second of that call; null when the provider measured no duration. */
    tokensPerSecond: number | null;
  } | null = null;
  /** Sum of every `token_usage` total seen this session. */
  private sessionTokens = 0;
  /**
   * Transcript characters at the moment of the last billed call.
   *
   * The context estimate is "what the last request cost" plus "what has been
   * added since", and this is the point the "since" is measured from.
   */
  private usageCharBaseline = 0;
  /**
   * Last git branch read for the footer, and when.
   *
   * The footer repaints on every frame and a branch is a file read; caching for
   * a couple of seconds keeps a streaming turn from reading `.git/HEAD` at
   * frame rate while still noticing a checkout during a session.
   */
  private gitBranchCache: { readonly cwd: string; readonly branch: string | null; readonly at: number } | null = null;
  /**
   * Effort reported by the run currently (or last) streaming.
   *
   * `options.effort` describes what the NEXT turn will use; this is what the
   * Host actually started the last one with. The former wins when present —
   * the user just chose it — and this keeps the border honest when effort is
   * decided elsewhere (a Desktop-scheduled run, a default in the worker).
   */
  private runEffort: string | null = null;

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
    this.theme = this.resolveTheme(options.theme ?? null);
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

    // The renderer is owned end to end: nothing sits between this class and the
    // byte stream. What `blessed.program` used to answer — terminal size, colour
    // depth, unicode — are facts this app now reads for itself, so they are
    // published as a plain record for tests to assert against.
    const renderConfig: RenderConfig = {
      terminal: this.terminalEnv.term,
      colors: this.terminalEnv.colorDepth === 'truecolor' ? 16 : this.terminalEnv.colorDepth,
      unicode: this.terminalEnv.unicodeBox,
    };
    proxy.renderConfig = renderConfig;

    const inline = options.inline === true;
    this.inlineSurface = inline
      ? new InlineSurface({
          output: this.output,
          size: () => this.terminalSize(),
        })
      : null;
    this.completionRows = Math.max(1, options.completionRows ?? 8);
    this.expanded = options.expandBlocks ?? false;
    this.showThinking = options.showThinking ?? true;
    // Collapsed by default, like the `expanded` flag it shares a keybinding
    // with: the transcript is a conversation, and a tool's JSON is a detail.
    this.showToolResults = options.showToolResults ?? false;
    this.maxInputRows = Math.max(1, options.maxInputRows ?? MAX_INPUT_ROWS);
    this.completion = new CompletionController(
      options.completionSources ?? EMPTY_COMPLETION_SOURCES,
    );

    this.fullScreen = createScreenSurface({
      statusRows: STATUS_ROWS,
      overlayWidth: OVERLAY_WIDTH,
      output: this.output,
      getSize: () => this.terminalSize(),
      unicodeBox: this.terminalEnv.unicodeBox,
    });

    // Full-screen mode builds its five regions now. Inline mode keeps the
    // alternate buffer unopened until an overlay raises it: opening that buffer
    // is irreversible for the rest of the frame, so it is raised lazily by
    // exactly the case that needs it.
    if (!inline) this.fullScreen.attachAll();

    if (options.history !== undefined && options.history.length > 0) {
      this.editor.loadHistory(options.history);
    }

    this.scheduler = new RenderScheduler({ onRender: () => this.paint() });

    this.bindKeys();
    this.bindPaste();
    this.bindResize();

    // The own renderer reads bytes itself and dispatches through `keyHandlers`.
    // Blessed's Program still gets a PassThrough so it never sees the real
    // stream: two parsers on one stdin would each emit a key per keystroke.
    this.inputDriver = this.renderer === 'own'
      ? createInputDriver()
      : null;
    this.inputDriver?.start(this.terminal.input, (event) => this.dispatchInput(event));

    // Kitty keyboard flags are PUSHED only when the environment says the
    // terminal speaks the protocol, and popped on teardown. Off by default:
    // enabling it rewrites the encoding of every key, and a terminal that
    // half-implements it would leave the user unable to type.
    if (this.inputDriver !== null && this.inputDriver.capabilities().kitty && this.kittyKeyboard()) {
      this.output.write(pushKittyKeyboardFlags());
    }

    // Bracketed paste: without it a paste arrives as a key storm, and the
    // newlines inside it submit. The driver recognises the markers and turns
    // the whole payload into one `paste` event.
    this.output.write(enableBracketedPaste());
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
    // shell the user returns to swallows clicks and wheel events. Both modes
    // are written as raw sequences now, and both MUST be undone.
    this.output.write(disableMouseReporting());
    this.output.write(disableBracketedPaste());
    // Exactly one of these exists. Destroying a Screen leaves the alternate
    // buffer; `InlineSurface.stop` leaves the conversation on the normal one.
    this.releaseAltScreen();
    this.inlineSurface?.stop();
    this.stopSpinner();
    if (this.inputDriver !== null) {
      // Pop whatever we pushed, BEFORE detaching: a pushed flag left behind
      // outlives the process as a broken keyboard for the shell the user
      // returns to.
      if (this.inputDriver.capabilities().kitty && this.kittyKeyboard()) {
        this.output.write(popKittyKeyboardFlags());
      }
      this.inputDriver.stop();
    }
    this.terminal.dispose();
    // Clipboard images live in a temp directory the worker reads by path only
    // during a turn, so this process exiting ends the file's useful life.
    void disposeClipboardTempDir();
  }

  /** Repaint external controller state, such as pending follow-ups. */
  refresh(): void {
    this.scheduler.requestImmediate();
  }

  /**
   * Adopt a fresh Host snapshot of background bash tasks.
   *
   * The task view is fed by two sources (see `background-tasks.ts`); this is
   * the polled half. Subagents arrive through `push()` as run frames.
   */
  setBackgroundTasks(snapshot: BackgroundTaskListV1): void {
    if (!this.backgroundTasks.applyBashSnapshot(snapshot)) return;
    this.clampTaskSelection();
    this.scheduler.requestImmediate();
  }

  /** True while any tracked task — bash or subagent — is still running. */
  hasRunningBackgroundTasks(): boolean {
    return this.backgroundTasks.hasRunning();
  }

  /** True while the task view owns the arrows (F6 / `/tasks`). */
  isTaskViewOpen(): boolean {
    return this.focus === 'tasks';
  }

  /** Grouped tasks for the task view and the summary line. */
  backgroundTaskGroups(): readonly BackgroundTaskGroup[] {
    return this.backgroundTasks.groups();
  }

  /** Flattened, selection-ordered rows for the task view. */
  backgroundTaskRows(): readonly BackgroundTaskRow[] {
    return this.backgroundTasks.rows();
  }

  /**
   * Enter the task view. F6 and `/tasks` both land here so the two entrances
   * cannot disagree about what "the task view" selects.
   */
  openTasks(): void {
    if (this.disposed) return;
    if (this.focus !== 'tasks') {
      this.focus = 'tasks';
      this.completion.close();
      const rows = this.backgroundTaskRows();
      this.selectedTaskRow = rows.length === 0 ? -1 : 0;
    }
    // The bash half is polled, not pushed; opening the view is the explicit
    // request for a current reading while the timer is quiet.
    this.options.onBackgroundTasksRefresh?.();
    this.scheduler.requestImmediate();
  }

  /** Force a repaint after the wiring read a fresh snapshot out of band. */
  private clampTaskSelection(): void {
    const count = this.backgroundTasks.rows().length;
    if (count === 0) this.selectedTaskRow = -1;
    else if (this.selectedTaskRow < 0) this.selectedTaskRow = 0;
    else if (this.selectedTaskRow >= count) this.selectedTaskRow = count - 1;
  }

  /** Move a draft the controller recalled back into the composer. */
  recallIntoComposer(text: string): void {
    this.editor.setText(text, Array.from(text).length);
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  private isBusyNow(): boolean {
    return this.options.isBusy?.() ?? this.busy;
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

  /**
   * Resolve a requested theme against what this terminal can actually render.
   *
   * `null` re-probes the environment, which is what the `system` setting means:
   * a user who picks `system` mid-session expects a re-read, not the answer the
   * process happened to compute at launch.
   */
  private resolveTheme(name: ThemeName | null): ReturnType<typeof themeFor> {
    const requested = name ?? resolveThemeName();
    // A light theme on a 16-colour terminal does not degrade, it disintegrates:
    // the palette is 256-colour numbers, so every tag quantises to something
    // arbitrary. Falling back keeps the reading experience; the user can still
    // force `light` on a 256-colour terminal where it works.
    return themeFor(
      requested === 'light' && !this.terminalEnv.supportsLightPalette ? 'dark' : requested,
    );
  }

  /**
   * Switch the palette without restarting.
   *
   * The transcript is repainted from scratch rather than recoloured, because
   * the theme tags are part of how lines were assembled: a cached transcript
   * keeps the old tags and repainting it in place would leave half the screen
   * on the previous palette.
   */
  setTheme(name: ThemeName | null): void {
    const next = this.resolveTheme(name);
    if (next.name === this.theme.name) return;
    this.theme = next;
    this.noteTranscriptMutation();
    if (this.disposed) return;
    this.scheduler.requestImmediate();
  }

  /** The theme actually in force, after the terminal's own fallback. */
  activeThemeName(): ThemeName {
    return this.theme.name;
  }

  /**
   * Move the preferences the running TUI can move, and repaint.
   *
   * The menu calls this once per row change so the effect is visible before the
   * menu is even closed — a settings list you have to leave to see the result
   * of is a settings list you cannot tune. Effort additionally leaves through
   * `onEffortChange`, because the value a run is started with belongs to the
   * chat loop, not to the renderer.
   */
  applyTuiPreferences(patch: TuiLivePreferences): void {
    if (patch.effort !== undefined) this.options.onEffortChange?.(patch.effort);
    if (patch.locale !== undefined) this.options.onLocaleChange?.(patch.locale);
    if (patch.theme !== undefined) this.setTheme(patch.theme);
    if (patch.showThinking !== undefined) this.showThinking = patch.showThinking;
    if (patch.expandBlocks !== undefined) this.expanded = patch.expandBlocks;
    if (patch.showToolResults !== undefined) this.showToolResults = patch.showToolResults;
    if (patch.completionRows !== undefined) {
      this.completionRows = Math.max(1, patch.completionRows);
    }
    if (patch.inputRows !== undefined) this.maxInputRows = Math.max(1, patch.inputRows);
    // Expanding or hiding blocks changes which lines exist, not just how they
    // are coloured, so the assembled transcript is stale rather than merely
    // dirty: drop it and let the next paint rebuild it.
    if (patch.expandBlocks !== undefined || patch.showThinking !== undefined) {
      this.noteTranscriptMutation();
    }
    if (this.disposed) return;
    this.scheduler.requestImmediate();
  }

  /**
   * The live preferences, so `/settings` can label rows with what is in force.
   *
   * Named after `TuiSlashHost.liveTuiPreferences` on purpose: the same method
   * under two names is exactly how the menu ends up labelling a row with the
   * SAVED value while the screen shows a different one, which is what happened
   * when this was called `livePreferences` and the host contract called it
   * `liveTuiPreferences` — the lookup silently fell through to a default.
   */
  liveTuiPreferences(): {
    theme: ThemeName;
    showThinking: boolean;
    expandBlocks: boolean;
    showToolResults: boolean;
    completionRows: number;
    inputRows: number;
  } {
    return {
      // What is in force, not what was requested: on a 16-colour terminal a
      // request for `light` is in force as `dark`, and a row that claimed
      // otherwise would be lying about the screen in front of the user.
      theme: this.theme.name,
      showThinking: this.showThinking,
      expandBlocks: this.expanded,
      showToolResults: this.showToolResults,
      completionRows: this.completionRows,
      inputRows: this.maxInputRows,
    };
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

  /**
   * Open a selectable list of view entries (plugins, connections, skills…).
   *
   * The difference from `chooseFiltered` is lifecycle, not looks: this list is
   * a BROWSER, not a picker. It stays open after Enter, and Enter hands the
   * selected value to `onEnter`, which is expected to open the entry's detail
   * page via {@link showDetailPanel} — whose Esc then comes back here. A
   * command that only needs "pick one and leave" keeps using `chooseFiltered`.
   *
   * `initialSelected` re-opens the list on the row that opened the detail, so
   * browsing several entries does not lose the user's place.
   */
  showListPanel(
    title: string,
    items: readonly WindowItem[],
    options: {
      readonly footer?: string;
      readonly onEnter?: (value: string) => void;
      readonly initialSelected?: number;
    } = {},
  ): void {
    if (this.windowOpenBlocked()) return;
    this.completion.close();
    this.windowMgr.open({
      title,
      items,
      filterable: true,
      footer: options.footer ?? 'type to filter · ↑↓ choose · Enter details · Esc close',
      ...(options.onEnter === undefined ? {} : { onSubmit: options.onEnter }),
      ...(options.initialSelected === undefined ? {} : { initialSelected: options.initialSelected }),
    });
    this.scheduler.requestImmediate();
  }

  /**
   * Open a scrollable detail page over a list entry.
   *
   * Closing the page (Esc) calls `onBack`, which re-opens the list the entry
   * came from — the browser cycle a view command wants. Without `onBack` this
   * is exactly `showPanel` with a back hint.
   */
  showDetailPanel(
    title: string,
    lines: readonly string[],
    options: { readonly footer?: string; readonly onBack?: () => void } = {},
  ): void {
    if (this.windowOpenBlocked()) return;
    this.completion.close();
    this.windowMgr.open({
      title,
      lines,
      scrollable: true,
      footer: options.footer ?? 'Esc back',
      ...(options.onBack === undefined ? {} : { onCancel: options.onBack }),
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

  /**
   * Open a live settings list: a filterable row per setting, whose Enter
   * cycles the value in place and whose effect is visible immediately.
   *
   * `onActivate` returns the rows as they should now read; returning them (rather
   * than having the caller call back in) keeps one owner of the list's content
   * and makes a row that forgets to redraw impossible. The window stays open
   * until Esc, and the promise settles then, so a slash command can `await` it
   * and know when the user is done.
   */
  async openSettings(options: {
    readonly title: string;
    readonly rows: readonly TuiSettingsRow[];
    readonly footer: string;
    readonly onActivate: (id: string) => readonly TuiSettingsRow[] | void;
  }): Promise<void> {
    if (this.windowOpenBlocked()) return;
    this.completion.close();
    let settle: () => void = () => {};
    const closed = new Promise<void>((resolve) => { settle = resolve; });
    const toItems = (rows: readonly TuiSettingsRow[]) => rows.map((row) => ({
      label: row.label,
      value: row.id,
      valueLabel: row.valueLabel,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
    }));
    this.windowMgr.open({
      title: options.title,
      items: toItems(options.rows),
      filterable: true,
      footer: options.footer,
      onActivate: (id) => {
        const next = options.onActivate(id);
        if (next !== undefined) this.windowMgr.updateItems(toItems(next));
        this.scheduler.requestImmediate();
      },
      onCancel: () => settle(),
    });
    this.scheduler.requestImmediate();
    return closed;
  }

  /**
   * Open a tabbed rich panel in the dock (630a): a tab strip with per-tab
   * lists, header/content focus, single-letter row actions. Resolves when the
   * user leaves it.
   *
   * The command gets its live handle through `onOpen`, not the return value —
   * the promise is reserved for "the user left", which is the moment a panel
   * that marked rows dirty until now performs its writes.
   */
  showRichPanel(options: {
    readonly title: string;
    readonly tabs: readonly RichPanelTab[];
    readonly initialTab?: string;
    readonly onClose?: () => void;
    readonly onOpen?: (panel: RichPanelHandle) => void;
  }): Promise<void> {
    if (this.windowOpenBlocked()) return Promise.resolve();
    this.completion.close();
    const spec: RichPanelSpec = {
      title: options.title,
      tabs: options.tabs,
      ...(options.initialTab === undefined ? {} : { initialTab: options.initialTab }),
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    };
    const controller = new RichPanelController(spec);
    this.activeRichPanel = controller;
    let settle: () => void = () => {};
    const closed = new Promise<void>((resolve) => { settle = resolve; });
    this.windowMgr.open({
      title: options.title,
      controller,
      onCancel: () => {
        if (this.activeRichPanel === controller) this.activeRichPanel = null;
        settle();
      },
    });
    options.onOpen?.({
      syncTab: (tabId, section) => { controller.syncTab(tabId, section); },
      activeTabId: () => controller.activeTabId(),
      activeSelectedValue: () => controller.activeSelectedValue(),
      // Closing through the dock, not through the controller: the window host
      // is what fires the panel's flush and releases `activeRichPanel`, so a
      // command leaving the panel looks exactly like the user leaving it.
      close: () => this.windowMgr.close(),
    });
    this.scheduler.requestImmediate();
    return closed;
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
    const tasks = this.taskViewLines();
    const queued = this.queuePreviewLines();
    // Composer, then popup, then footer — pi's order. The candidate list hangs
    // directly under the line being typed into, so the reader's eye does not
    // have to jump over the input to find it, and the footer stays at the
    // bottom of the page rather than being pushed up by a list that grew.
    const chrome = [...tail, ...tasks, ...queued, ...this.inlineInputLines, ...this.inlinePopupLines, ...this.inlineStatusLines];
    // The caret's row is an index into `scroll`, so it is offset by everything
    // that sits above the composer. Its column is the editor's own column plus
    // the prompt marker's width, because that is what is actually printed.
    const caret =
      this.focus === 'input' && !this.dockPanelActive()
        ? {
            row:
              tail.length +
              tasks.length +
              queued.length +
              this.inputCursor.cursorRow - 1,
            column: this.inputCursor.cursorCol + 1,
            region: 'chrome' as const,
          }
        : null;
    this.inlineSurface?.render({
      scroll: this.inlineTranscriptLines,
      chrome,
      caret,
    });
  }

  /** True when something needs the full-screen takeover. */
  private overlayActive(): boolean {
    // ONLY the permission/question overlay. A slash secondary page, the
    // settings menu and a login prompt are docked into the composer's slot
    // (see `paintInput`), so they never take the alternate buffer away from
    // the conversation — which is the whole difference the user sees between
    // "my terminal" and "some app".
    return this.overlay.body(this.options.canAnswerPermissions?.() ?? false) !== null;
  }

  /**
   * The working tail: one row, empty when nothing is running.
   *
   * Shown only in inline mode. Full-screen mode has a fixed four-row layout and
   * the status line is where its activity has always lived; giving it a tail too
   * is a separate change to that layout, not something to smuggle in here.
   *
   * The row outlives the turn when background work does not: a promoted bash
   * command or a subagent can still be running after the model is done, and a
   * summary that vanished at `done` would leave the only working thing on
   * screen invisible. The glyph goes static in that case — nothing in the TURN
   * is moving, and a spinner would say otherwise.
   */
  private workingTailLines(): string[] {
    // Keyed on the inline surface, not on the absence of the status bar: the
    // status bar being null IS inline mode today, but a full-screen mode that
    // grows its own tail later must not be switched off by this line.
    if (this.inlineSurface === null) return [];
    const busy = this.options.isBusy?.() ?? this.busy;
    const counts = this.backgroundSummaryCounts();
    const active = busy || this.waitingForPermission;
    if (!active && counts.backgroundSummaryTotal === 0) return [];
    return [
      workingTailLine({
        frame: this.spinnerFrame,
        label: this.activityLabel(busy) + backgroundSummarySuffix({
          bashRunning: counts.bashRunning,
          subagentRunning: counts.subagentRunning,
          totalTasks: counts.backgroundSummaryTotal,
        }),
        unicode: this.terminalEnv.unicodeBox,
        columns: this.terminalSize().columns,
        active,
      }),
    ];
  }

  /**
   * Chrome rows above the composer in inline mode: the working tail, the task
   * list while it is focused, and the queued-prompt preview. Every layout
   * budget subtracts exactly this, or a frame would claim a row it does not
   * have and push the footer off the bottom.
   */
  private aboveComposerRows(): number {
    return this.workingTailLines().length + this.taskViewLines().length + this.queuePreviewLines().length;
  }

  /** Running/total counts for the summary, computed once per paint. */
  private backgroundSummaryCounts(): {
    bashRunning: number;
    subagentRunning: number;
    backgroundSummaryTotal: number;
  } {
    let bashRunning = 0;
    let subagentRunning = 0;
    let total = 0;
    for (const group of this.backgroundTasks.groups()) {
      total += group.tasks.length;
      if (group.id === 'bash') bashRunning = group.running;
      else subagentRunning = group.running;
    }
    return { bashRunning, subagentRunning, backgroundSummaryTotal: total };
  }

  /**
   * The task list, rendered into the chrome above the composer while the
   * task focus owns the arrows. Empty in every other focus: it is a mode, not
   * a permanently docked panel.
   */
  private taskViewLines(): string[] {
    if (this.focus !== 'tasks' || this.inlineSurface === null) return [];
    const width = Math.max(1, this.terminalSize().columns - 1);
    const rows = this.backgroundTaskRows();
    const lines: string[] = [];
    lines.push(escapeTags(compactActivity(
      'Tasks · ↑↓ select · ←→ fold · Enter open · Esc back',
      width,
    )));
    if (rows.length === 0) {
      lines.push(escapeTags(compactActivity(
        this.backgroundTasks.observed ? 'No background tasks.' : 'Background task list unavailable for this Host.',
        width,
      )));
      return lines;
    }
    const budget = Math.max(3, Math.min(8, this.terminalSize().rows - 10));
    const selected = this.selectedTaskRow < 0 ? 0 : this.selectedTaskRow;
    const first = Math.max(0, Math.min(selected - (budget - 1), Math.max(0, rows.length - budget)));
    for (let index = first; index < Math.min(rows.length, first + budget); index += 1) {
      const row = rows[index]!;
      lines.push(row.kind === 'group'
        ? this.taskGroupLine(row.group, index === selected, width)
        : this.taskRowLine(row.task, index === selected, width));
    }
    return lines;
  }

  private taskGroupLine(group: BackgroundTaskGroup, selected: boolean, width: number): string {
    const marker = group.collapsed ? '▸' : '▾';
    const running = group.running > 0 ? ` · ${group.running} running` : '';
    const text = compactActivity(`${marker} ${group.label} (${group.tasks.length})${running}`, width - 2);
    return selected ? `{cyan-fg}❯ ${text}{/cyan-fg}` : `{gray-fg}  ${text}{/gray-fg}`;
  }

  private taskRowLine(task: BackgroundTaskView, selected: boolean, width: number): string {
    const elapsed = formatTaskDuration((task.endedAtMs ?? Date.now()) - task.startedAtMs);
    const suffix = task.status === 'running'
      ? ` · ${elapsed}`
      : ` · ${task.status} · ${elapsed}`;
    // Truncate the PLAIN text: fitting a line that already carries tags would
    // count markup as columns and can cut a tag in half (see working-tail.ts).
    const text = compactActivity(
      `${selected ? '❯' : ' '} ${taskStatusGlyph(task.status, this.terminalEnv.unicodeBox)} ${task.title}${suffix}`,
      width,
    );
    return selected ? `{cyan-fg}${text}{/cyan-fg}` : text;
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
    return {
      expanded: this.expanded,
      // Either switch opens a result body: `expanded` is the transcript-wide
      // toggle, this one is the standing preference from `/settings`.
      showToolResults: this.expanded || this.showToolResults,
      toolResultLines: 5,
      ...(this.showThinking ? {} : { showThinking: false }),
      theme: this.theme.tags,
      // plan 615 Phase 0: markdown emphasis/strike map to italic/strike only
      // when the surface can express those attributes.
      renderer: this.renderer,
      // The pane width block renderers may span (horizontal rules). Inline
      // mode has no pane border, so the full terminal width is the budget;
      // full-screen asks the surface for the transcript pane and subtracts the
      // border it costs. `innerWidth` is that cost — blessed's `iwidth` — not
      // the content width, so a borderless transcript reports 0 and yields the
      // full pane width rather than a zero-column wrap budget.
      width: this.inlineSurface !== null
        ? this.terminalSize().columns
        : transcriptWidth(this.fullScreen.measure('transcript'), this.terminalSize().columns),
    };
  }

  /** Invalidate the assembled lines after a private transcript-model change. */
  private noteTranscriptMutation(): void {
    this.transcriptRevision += 1;
  }

  /**
   * Hand the pane this frame's inputs, then paint what it answers.
   *
   * The windowing arithmetic that used to live here (maxStart, clamp, slice) is
   * `visibleWindow()` behind the pane now. Keeping it here meant the inline path
   * had to re-express the same decision as a viewport offset, and two
   * expressions of "which line is on top" is exactly the disagreement plan 615
   * Phase 4 set out to remove.
   */
  private paintTranscript(): void {
    const width = this.terminalSize().columns;
    const pane = this.transcriptPane;
    pane.props = {
      renderer: this.transcript,
      model: this.model,
      options: this.renderOptions(),
      scrollTop: this.scrollTop,
      following: this.follow,
      revision: this.transcriptRevision,
    };
    if (this.inlineSurface !== null) {
      // The WHOLE transcript, unwindowed. Deciding what the live area shows and
      // committing the rest to scrollback is the surface's job, and it cannot do
      // either if the transcript arrives pre-sliced: "which rows scrolled off" is
      // exactly the information that slicing destroys.
      this.inlineTranscriptLines = [...pane.lines(width)];
      return;
    }
    this.fullScreen.update('transcript', {
      // The border is the focus tell in full-screen mode: the task list owns
      // the arrows while the transcript does not respond to them at all.
      borderColor: this.focus === 'tasks' ? 'cyan' : 'gray',
      lines: [...pane.visibleLines(width, this.visibleTranscriptRows())],
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
    const screenRows = asNumber((this.output as { rows?: unknown }).rows, 24);
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

  /**
   * Pixel rows the composer spends on chrome (border or blank padding), which
   * is NOT the same as the box's inner height.
   *
   * This used to return `measure('input').innerHeight`, which fed the height
   * of the PREVIOUS frame back into the next one: on a 2-row terminal the box
   * measured 6 tall, that 6 became `inputChromeRows()`, and the composer was
   * re-laid out at 8 — the input slid off the top of the screen (plan 615
   * Phase 0 probe: `top: -5`, `height: 6` on a 2-row terminal). Blessing that
   * value works only because blessed re-derives `iheight` from a fixed 3-row
   * box each frame; growth never compounds there.
   *
   * Derived from the terminal's row budget instead, so it is a function of
   * size and NOT of the previous frame: a composer gets a border only when
   * there is room for one plus at least one body row.
   */
  private inputChromeRows(): number {
    const availableRows = Math.max(
      1,
      this.terminalSize().rows -
        this.footerRows() -
        (this.inlineSurface !== null
          ? this.aboveComposerRows()
          : 0) -
        this.popupRows(),
    );
    return availableRows >= 3 ? 2 : 0;
  }

  /** Rows the status/footer area owns, which differs by presentation. */
  private footerRows(): number {
    return this.inlineSurface === null ? STATUS_ROWS : INLINE_FOOTER_ROWS;
  }

  /**
   * Rows from the bottom of the screen to the composer's lower edge.
   *
   * The status row, plus the completion popup when it is open: the popup hangs
   * BELOW the composer (pi's order), so opening it lifts the input box by its
   * own height instead of covering the transcript above it.
   */
  private composerBottom(size: TerminalSize): number {
    return Math.min(STATUS_ROWS + this.popupRows(), Math.max(0, size.rows - 1));
  }

  /** Rows the popup occupies right now, borders included. Zero when closed. */
  private popupRows(): number {
    // A secondary page owns the slot the popup would hang below, so the popup
    // reserves nothing while one is open — even if it was open before (F1
    // pressed mid-prompt) and will be again after Esc.
    if (!this.completion.isOpen || this.dockPanelActive()) return 0;
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
    const availableRows = Math.max(1, size.rows - this.footerRows() -
      (inline ? this.aboveComposerRows() : 0) - this.popupRows());
    if (!inline) {
      // Blessed computes padding from the presence of a border object, even
      // when individual edges are false. Remove the object on tiny screens.
      this.fullScreen.update('input', {
        borderStyle: availableRows >= 3 ? 'composer' : 'none',
      });
    }

    // A secondary page (a slash-command list, the settings menu, a login
    // prompt) takes the composer's slot rather than a centred box: same rows,
    // same rules, full width. That is pi's `showSelector`, and it is what keeps
    // the conversation above the panel readable while the list is open.
    const panel = this.dockPanelLines(Math.max(1, availableRows - 2), this.dockWidth(inline, size));
    if (panel !== null) {
      this.paintDockPanel(panel, inline, size);
      return;
    }

    const layout = buildComposerLayout(this.editor.text, this.editor.cursor, {
      columns: inline ? Math.max(1, size.columns - 1) : this.composerWidth(),
      terminalRows: availableRows,
      maxRows: this.maxInputRows,
      unicode: this.terminalEnv.unicodeBox,
      ...(this.options.turnSuggestion?.() ? { placeholder: this.options.turnSuggestion!() ?? undefined } : {}),
    });
    const borderRows = layout.lines.length - layout.bodyRows;
    if (!inline) {
      const height = layout.bodyRows + this.inputChromeRows();
      const body = borderRows > 0 ? layout.lines.slice(1, -1) : layout.lines;
      this.fullScreen.update('input', {
        // The composer's frame is the effort indicator: the two rules the user
        // types between carry the level the next message will run at.
        borderColor: effortBorderColor(this.effortLevel()),
        height,
        bottom: this.composerBottom(size),
        lines: this.colorComposerBody(body, 0, layout.hasPlaceholder),
      });
      this.fullScreen.update('transcript', {
        bottom: height + STATUS_ROWS + this.popupRows(),
      });
    } else {
      this.inlineInputLines = this.colorComposerRules(
        layout.lines,
        borderRows > 0,
        layout.hasPlaceholder ? (borderRows > 0 ? 1 : 0) : -1,
      );
    }
    this.inputRows = layout.bodyRows;
    this.inputCursor = {
      rows: layout.lines,
      cursorRow: layout.cursorRow - (inline ? 0 : borderRows / 2),
      cursorCol: layout.cursorColumn - 1,
    };
  }

  /** True while a secondary page owns the composer's slot. */
  private dockPanelActive(): boolean {
    return this.interactivePrompt !== null || this.windowMgr.isActive;
  }

  /** Columns a docked panel may use, matching the composer's own width. */
  private dockWidth(inline: boolean, size: TerminalSize): number {
    return inline ? Math.max(1, size.columns - 1) : this.composerWidth();
  }

  /** Rows of the active secondary page, or null when the composer owns the slot. */
  private dockPanelLines(maxRows: number, width: number): string[] | null {
    if (this.interactivePrompt !== null) {
      return this.renderInteractivePrompt(this.interactivePrompt, width, maxRows).split('\n');
    }
    if (!this.windowMgr.isActive) return null;
    const body = this.windowMgr.renderDocked(maxRows, width);
    return body === null ? null : [...body];
  }

  /**
   * Paint a secondary page in the composer's slot.
   *
   * Inline mode frames it with the same two rules the composer uses, because
   * the panel IS the composer as far as the layout is concerned — the same
   * rows, in the same place, so opening `/model` does not move the footer. In
   * full-screen mode the input region already draws those rules, so only the
   * body is sent.
   *
   * The body arrives tagged (`{cyan-fg}❯ /model{/cyan-fg}`) and is therefore
   * NOT escaped here: the window manager escapes the data it interpolates, and
   * escaping the whole line would print the markup as text.
   */
  private paintDockPanel(body: readonly string[], inline: boolean, size: TerminalSize): void {
    const budget = Math.max(1, size.rows - this.footerRows() - 2
      - (inline ? this.aboveComposerRows() : 0));
    const visible = body.slice(0, budget);
    if (inline) {
      const columns = Math.max(1, size.columns - 1);
      const rule = this.mutedRule(columns);
      this.inlineInputLines = [rule, ...visible, rule];
    } else {
      const height = visible.length + this.inputChromeRows();
      this.fullScreen.update('input', {
        borderColor: 'cyan',
        height,
        bottom: this.composerBottom(size),
        lines: visible,
      });
      this.fullScreen.update('transcript', {
        bottom: height + STATUS_ROWS + this.popupRows(),
      });
    }
    this.inputRows = visible.length;
    // The caret belongs to the composer; a panel has no text cursor of its own
    // (a text prompt draws its own `|` marker inside the body).
    this.inputCursor = { rows: visible, cursorRow: 1, cursorCol: 0 };
  }

  /** One horizontal rule in the theme's muted colour. */
  private mutedRule(columns: number): string {
    const tag = this.theme.tags.muted;
    return `{${tag}}${'─'.repeat(Math.max(1, columns))}{/${tag}}`;
  }

  /** The effort level the next turn will run at. */
  private effortLevel(): EffortLevel {
    return normalizeEffort(this.options.effort?.() ?? this.runEffort);
  }

  /**
   * Paint the composer's two rules in the effort colour.
   *
   * Only the RULES are coloured. The text keeps the terminal's own foreground,
   * because a border that tints the thing you are typing is a filter, not an
   * indicator — pi colours the frame for the same reason.
   */
  private colorComposerRules(lines: readonly string[], hasRules: boolean, placeholderRow = -1): string[] {
    const mutedTag = this.theme.tags.muted;
    const paint = (line: string, index: number): string => {
      const escaped = escapeTags(line);
      return index === placeholderRow ? `{${mutedTag}}${escaped}{/${mutedTag}}` : escaped;
    };
    if (!hasRules || lines.length < 2) return lines.map(paint);
    const tag = effortBorderTag(this.effortLevel(), this.theme.name);
    const tagBody = `{${tag}}`;
    const close = `{/${tag}}`;
    return lines.map((line, index) => {
      const painted = index === 0 || index === lines.length - 1
        ? `${tagBody}${escapeTags(line)}${close}`
        : paint(line, index);
      return index === placeholderRow ? `{${mutedTag}}${painted}{/${mutedTag}}` : painted;
    });
  }

  /**
   * Paint the composer's body rows, dimming the placeholder row.
   *
   * The placeholder is the next prompt the worker predicted for the last turn.
   * It is drawn muted so it reads as a hint rather than as text the user
   * typed.
   */
  private colorComposerBody(lines: readonly string[], placeholderRow: number, hasPlaceholder: boolean): string[] {
    const mutedTag = this.theme.tags.muted;
    return lines.map((line, index) => {
      const escaped = escapeTags(line);
      return hasPlaceholder && index === placeholderRow
        ? `{${mutedTag}}${escaped}{/${mutedTag}}`
        : escaped;
    });
  }

  private queuePreviewLines(): string[] {
    const pending = this.options.queuedDrafts?.() ?? [];
    if (pending.length === 0 || this.terminalSize().rows < 7) return [];
    const width = Math.max(1, this.terminalSize().columns - 1);
    const shown = pending.slice(-QUEUE_PREVIEW_ROWS);
    const hidden = pending.length - shown.length;
    const lines = shown.map((draft) => escapeTags(compactActivity(
      (draft.mode === 'steer' ? '↳ steer' : '⧗ queued') + ' · ' + draft.text.replace(/\s+/gu, ' '),
      width,
    )));
    if (hidden > 0) lines.unshift(`… ${hidden} earlier`);
    return lines;
  }

  private placeCursor(): void {
    if (this.focus !== 'input' || this.dockPanelActive()) {
      this.output.write(hideCursor());
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
    // `cursorTo` is 1-based; the region metrics are 0-based, so the conversion
    // lives here and nowhere else.
    this.output.write(cursorTo(Math.max(0, y) + 1, Math.max(0, col) + 1));
    this.output.write(showCursor());
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
    // A secondary page owns the slot the popup would open into. Hiding rather
    // than closing keeps the popup's state intact for a window opened over
    // typing (F1 mid-prompt) — on close the composer returns with its
    // candidates, because the input never changed.
    if (!this.completion.isOpen || this.dockPanelActive()) {
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

    // `+ 2` for the popup own border rows. It sits BELOW the composer, above
    // the status row — pi's order — so the input box is lifted by exactly the
    // rows the popup occupies (`paintInput` does that lift) and the two never
    // overlap.
    this.fullScreen.update('completion', {
      height: rows.length + 2,
      bottom: STATUS_ROWS,
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
    const taskRows = this.backgroundTaskRows();
    const taskSelection = this.selectedTaskRow < 0 ? 0 : this.selectedTaskRow + 1;
    const context = this.interactivePrompt?.kind === 'select'
      ? 'Enter select / Esc cancel'
      : this.interactivePrompt?.kind === 'text'
        ? 'Enter confirm / Esc cancel'
        : this.completion.isOpen
      ? this.completion.snapshot.argumentCommand !== undefined
        ? 'Enter run / Tab fill / arrows choose'
        : 'Tab accept / arrows choose'
      : busy
        ? 'Enter steer · Tab queue · Esc stop'
      : this.focus === 'tasks'
        ? `tasks ${taskSelection}/${taskRows.length} / arrows select / Enter open / Esc back`
        : `${this.editor.isEmpty ? 'Tab history' : 'Tab indent'} / F6 tasks / arrows prompts`;
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
        ? '/queue resume · Esc recall'
        : this.completion.isOpen ? context
        : busy ? 'Enter steer · Tab queue · Esc stop' : '/ commands · F1 help';
      this.inlineStatusLines = this.footerLines(width, hint + queueSegment);
      return;
    }
    const counts = this.backgroundSummaryCounts();
    const fixed = text + ' · ' + spinner + this.activityLabel(busy) + backgroundSummarySuffix({
      bashRunning: counts.bashRunning,
      subagentRunning: counts.subagentRunning,
      totalTasks: counts.backgroundSummaryTotal,
    }) + tail + usage + queueSegment + ' · ' + context;
    this.fullScreen.update('status', {
      lines: ['{gray-fg}' + escapeTags(compactActivity(fixed, width)) + '{/gray-fg}'],
    });
  }

  /**
   * The inline footer, in two rows.
   *
   * Row one is the session's location — path, branch, session name — with the
   * transient key hint right-aligned. Row two is the cost: tokens in, tokens
   * out, the session total, the context percentage, and the model paying for
   * it, right-aligned. See `footer.ts` for why the two are split rather than
   * competing for one row.
   */
  private footerLines(width: number, hint: string): string[] {
    const cwd = this.options.workspaceDirectory?.() ?? process.cwd();
    const budget = this.options.contextBudgetTokens?.() ?? null;
    return buildFooterLines({
      width,
      cwd,
      branch: this.gitBranch(cwd),
      sessionName: this.options.sessionName?.() ?? null,
      hint,
      stats: {
        // `lastUsage` is the most recent billed call, not the turn total; the
        // arrows are labelled accordingly, and the session sum is separate.
        inputTokens: this.lastUsage?.input ?? 0,
        outputTokens: this.lastUsage?.output ?? 0,
        totalTokens: this.sessionTokens,
        // The rate of that same most recent call, and null when the provider
        // reported no duration for it.
        outputTokensPerSecond: this.lastUsage?.tokensPerSecond ?? null,
        // Before the first billed call the footer says `?/window` rather than
        // `0%`: the window is a property of the model, the usage is not yet a
        // reading. Getting this wrong is how an idle prompt claims to have used
        // nothing and implies the model is free.
        contextPercent: budget !== null && budget > 0 && this.contextTokens() !== null
          ? this.contextPercent()
          : null,
        contextBudget: budget,
      },
      model: this.options.modelLabel?.() ?? null,
      styles: stylesOf({ theme: this.theme.tags }),
      home: process.env['HOME'] ?? process.env['USERPROFILE'],
    });
  }

  /** The branch for `cwd`, cached for `GIT_BRANCH_TTL_MS`. */
  private gitBranch(cwd: string): string | null {
    const at = Date.now();
    const cached = this.gitBranchCache;
    if (cached !== null && cached.cwd === cwd && at - cached.at < GIT_BRANCH_TTL_MS) {
      return cached.branch;
    }
    const branch = readGitBranch(cwd);
    this.gitBranchCache = { cwd, branch, at };
    return branch;
  }

  /**
   * Status-bar token segment: the context bar when a budget is resolvable,
   * otherwise the bare session total. Empty until the first `token_usage`
   * frame, so an idle prompt shows nothing.
   *
   * The output rate of the MOST RECENT billed call rides the same segment,
   * because it is the other half of the same question ("what did that call
   * cost?"). It is omitted when the provider measured no duration: a rate
   * that nobody measured is not a number, and a zero would be a measurement
   * nobody made.
   */
  private usageSegment(): string {
    const budget = this.options.contextBudgetTokens?.() ?? null;
    const rate = this.lastUsage?.tokensPerSecond ?? null;
    const rateSegment = rate === null ? '' : ` · ${formatTokensPerSecond(rate)}`;
    const tokens = this.contextTokens();
    if (budget !== null && budget > 0 && tokens !== null) return ` · ${this.contextBar()} ${this.contextPercent()}%${rateSegment}`;
    if (this.sessionTokens > 0) return ` · Σ ${formatTokens(this.sessionTokens)}${rateSegment}`;
    return rateSegment;
  }

  /** Show the most useful live activity without adding one transcript row per tick. */
  private activityLabel(busy: boolean): string {
    return this.activity.label(busy);
  }

  /**
   * Fold one frame into the activity tracker.
   *
   * `turn_start` is handled HERE rather than in the tracker: the only thing it
   * changes that this app paints is the composer border's effort level, and
   * that is a property of the composer, not of the activity line.
   */
  private updateActivity(frame: LegacyFrame): boolean {
    const changed = this.activity.apply(frame, this.busy);
    if (frame.type !== 'turn_start') return changed;
    const effort = frameString(frameRecord(frame.data), 'effort');
    if (effort === '' || effort === this.runEffort) return changed;
    this.runEffort = effort;
    return true;
  }


  private clearActiveActivity(): void {
    this.activity.clear();
    this.waitingForPermission = false;
  }

  /**
   * Paint the permission/question overlay into the centred region.
   *
   * This region is now ONLY the permission ask. Secondary pages used to live
   * here too, which is why opening `/model` covered the conversation with a box
   * in the middle of the screen and jumped into the alternate buffer. They are
   * docked into the composer's slot instead (`paintDockPanel`); a question that
   * blocks a tool call is the one thing still worth interrupting the view for.
   */
  private paintOverlay(): void {
    if (!this.fullScreen.ready) return;
    const body = this.overlay.body(this.options.canAnswerPermissions?.() ?? false);
    if (body === null) {
      this.fullScreen.update('overlay', { hidden: true });
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

  private renderInteractivePrompt(prompt: InteractivePrompt, width: number, maxRows: number): string {
    const lines = [`{bold}{cyan-fg}${escapeTags(prompt.title)}{/cyan-fg}{/bold}`, ''];
    // Title, a blank, the ellipsis markers and the hint row: the list gets
    // whatever is left of the slot the composer would have occupied.
    const visibleChoices = Math.max(1, Math.min(PROMPT_VISIBLE_CHOICES, maxRows - 4));
    if (prompt.kind === 'select') {
      const count = prompt.choices.length;
      const first = Math.max(0, Math.min(
        prompt.selectedIndex - Math.floor(visibleChoices / 2),
        Math.max(0, count - visibleChoices),
      ));
      if (first > 0) lines.push('{gray-fg}  …{/gray-fg}');
      const maxLineChars = Math.max(20, Math.floor(Math.max(1, width) * 0.8) - 6);
      for (let i = first; i < Math.min(count, first + visibleChoices); i += 1) {
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
      if (first + visibleChoices < count) lines.push('{gray-fg}  …{/gray-fg}');
      lines.push('', '{gray-fg}↑↓ choose · Enter select · Esc cancel{/gray-fg}');
      return lines.join('\n');
    }

    const codepoints = Array.from(prompt.value);
    const masked = prompt.secret ? codepoints.map(() => '*').join('') : prompt.value;
    const caret = prompt.secret ? Array.from(prompt.value.slice(0, prompt.cursor)).length : prompt.cursor;
    const maxVisible = Math.max(12, Math.min(56, Math.max(1, width) - 4));
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
    // Subagent rows are run-scoped, so they arrive as frames rather than in
    // the Host snapshot (which knows only about bash tasks).
    if (this.backgroundTasks.applyFrame(frame)) {
      this.clampTaskSelection();
      this.scheduleRender();
    }
    const key = readBlockKey(frameRecord(frame.data));
    switch (frame.type) {
      case 'text_delta': {
        if (!this.thinkingBuffer.isEmpty && this.commitBuffers()) this.noteTranscriptMutation();
        this.commitIfBlockChanged(this.textBuffer, key);
        this.textBuffer.append(readContent(frame), now(), key);
        this.pushContent();
        return;
      }
      case 'thinking_delta': {
        if (!this.textBuffer.isEmpty && this.commitBuffers()) this.noteTranscriptMutation();
        this.commitIfBlockChanged(this.thinkingBuffer, key);
        this.thinkingBuffer.append(readContent(frame), now(), key);
        this.pushContent();
        return;
      }
      case 'permission': {
        // Parallel tools can await independent approvals in the same run.
        // The queue keeps them ordered; deadlines and run end close stale asks.
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
        const output = typeof data['output_tokens'] === 'number' ? data['output_tokens'] : 0;
        // The provider's own request duration, when it reported one. The
        // rate comes from the shared pure function in `@duya/ai` so the TUI
        // and the Desktop cannot disagree about one number; a frame without
        // a duration produces no rate at all rather than a zero.
        const durationMs = typeof data['request_duration_ms'] === 'number'
          ? data['request_duration_ms']
          : undefined;
        this.lastUsage = {
          input: typeof data['input_tokens'] === 'number' ? data['input_tokens'] : 0,
          output,
          total,
          tokensPerSecond: durationMs === undefined
            ? null
            : calculateOutputTokensPerSecond(output, durationMs),
        };
        this.sessionTokens += total;
        // The context estimate is anchored here: everything the transcript
        // holds from now on is what the NEXT request would have to carry.
        this.usageCharBaseline = this.model.contextChars;
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
      expiresAt: typeof data['expiresAt'] === 'number' ? data['expiresAt'] : undefined,
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
    if (this.permissionRequestIds.has(request.requestId)) return Promise.resolve(null);
    this.permissionRequestIds.add(request.requestId);
    // A permission question outranks any modal window; the manager and the
    // overlay share one box, so leaving the window open would let the next
    // paint draw it over the question.
    this.windowMgr.close();
    this.waitingForPermission = true;
    return new Promise<PermissionDecision | null>((resolve) => {
      this.overlay.show(request, (decision: PermissionDecision | null, answers?: QuestionAnswers) => {
        this.onPermissionDecision?.(request.requestId, decision, answers);
        this.waitingForPermission = this.overlay.isActive;
        this.activity.phase = this.busy ? 'working' : 'ready';
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
   * Handle newly arrived CONTENT — a text or thinking delta.
   *
   * The first content of a burst is painted NOW rather than at the end of the
   * throttle window. The user is watching the screen hardest exactly there,
   * and the window it would otherwise land in was opened by a frame that did
   * not contain the content, so the frame they wait for shows nothing.
   *
   * Everything after the first content of a burst keeps the ordinary path:
   * the delta buffer's line quantisation decides when a fragment becomes
   * visible, and the scheduler's trailing throttle decides when it is
   * painted.
   */
  private pushContent(): void {
    const painted = this.scheduler.requestContent(() => {
      // The leading frame is painted right after this returns, so the content
      // has to be in the model NOW: a frame painted before the commit shows
      // nothing.
      if (this.commitBuffers()) this.noteTranscriptMutation();
    });
    if (!painted) this.drainBuffers();
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
      this.activity.phase = 'working';
      this.clearActiveActivity();
    } else if (this.activity.phase !== 'complete' && this.activity.phase !== 'failed') {
      this.activity.phase = 'ready';
      this.clearActiveActivity();
    }
    if (!busy) {
      this.overlay.abortAll();
      this.waitingForPermission = false;
      // A turn boundary commits whatever is left, so the transcript cannot
      // disagree with what actually happened.
      if (this.commitBuffers()) this.noteTranscriptMutation();
      if (this.model.finishRun()) this.noteTranscriptMutation();
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
    this.scrollTop = 0;
    this.focus = 'input';
    this.selectedTaskRow = -1;
    this.backgroundTasks.clear();
    this.activity.phase = 'ready';
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
    this.scrollTop = 0;
    this.focus = 'input';
    this.selectedTaskRow = -1;
    this.backgroundTasks.clear();
    this.activity.phase = 'ready';
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
   * Offer a control chord to the open window before the editor claims it.
   *
   * Only the rich panel has a vocabulary for chords (`C-d` = delete the
   * selected row, a letter = a row action); a plain window has none and just
   * needs the key kept away from the hidden composer. Either way, while a
   * window is on screen the chord is consumed.
   */
  private routeWindowControl(name: string): boolean {
    if (this.activeRichPanel === null) return this.swallowForWindow();
    if (this.windowMgr.handleKey(name, {})) {
      this.scheduler.requestImmediate();
      return true;
    }
    // The panel is modal, so a chord it does not claim is still not the
    // editor's: the draft under the dock is invisible, and a chord that
    // quietly killed half of it would be submitted on the next Enter.
    return this.swallowForWindow();
  }

  /**
   * An arrow key under an open window.
   *
   * In the panel's tab strip `←/→` move between tabs; everywhere else they
   * must still be swallowed. The editor's cursor is invisible under the dock,
   * so letting an unconsumed arrow fall through would silently rewrite the
   * draft the user cannot see — and a draft is what gets submitted on Enter.
   */
  private routeWindowArrow(name: 'left' | 'right'): boolean {
    if (!this.windowMgr.isActive) return false;
    if (this.activeRichPanel !== null && this.windowMgr.handleKey(name, {})) {
      this.scheduler.requestImmediate();
      return true;
    }
    return this.swallowForWindow();
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
    // Same table as the hand-written bindings, so an override lands where the
    // renderer actually reads it. On the blessed path this is still
    // `Program.key` under the hood; `bindKey` is the one place that decides.
    this.bindKey(keys, handler);
  }

  /**
   * Register a handler for one or more blessed key names.
   *
   * The names are the `key.full` strings (`C-c`, `M-y`, `S-tab`, `enter`) —
   * the SAME vocabulary `toBlessedKeys` produces, which is why overrides did
   * not need a second translator when the own path arrived.
   */
  private bindKey(names: readonly string[], handler: () => void): void {
    for (const name of names) {
      const existing = this.keyHandlers.get(name);
      if (existing === undefined) this.keyHandlers.set(name, [handler]);
      else existing.push(handler);
    }
  }

  /** Register the catch-all that runs for keys no binding claimed. */
  private onKeypress(handler: (ch: string, key: NormalizedKey) => void): void {
    this.keypressHandler = handler;
  }

  /** Register the mouse reporter. */
  private onMouse(handler: (event: InputMouseEvent) => void): void {
    this.mouseHandler = handler;
  }

  /**
   * Dispatch one normalised input event.
   *
   * The ORDER is blessed's, and it is load-bearing: `program.js:408-411`
   * emits `keypress` first and `key <full>` second. Reversing it would let the
   * text handler insert a character for a key a binding had already claimed —
   * the `\t` completion key would type a tab, and the same class of bug would
   * hit every contended binding.
   */
  private dispatchInput(event: InputEvent): void {
    switch (event.kind) {
      case 'key': {
        this.keypressHandler?.(event.key.ch ?? '', event.key);
        const handlers = this.keyHandlers.get(event.key.full);
        if (handlers === undefined) return;
        for (const handler of handlers) handler();
        return;
      }
      case 'paste':
        this.handleBracketedPaste(event.text);
        return;
      case 'mouse':
        this.mouseHandler?.(event.event);
        return;
    }
  }

  /**
   * Whether to ask for the kitty keyboard protocol.
   *
   * Opt-in while it is new: the protocol re-encodes EVERY key, and the only
   * evidence that a given terminal implements it correctly is that typing still
   * works on it. `DUYA_TUI_KITTY=1` turns it on for exactly that trial; the
   * environment-based capability check decides whether asking is even plausible.
   */
  private kittyKeyboard(): boolean {
    return process.env['DUYA_TUI_KITTY'] === '1';
  }

  /**
   * The key bindings actually in force this session.
   *
   * Named exactly `TuiSlashHost.effectiveKeyBindings` — when a TUI method and
   * the host contract disagree on the name, the optional call silently falls
   * through to a default, and that happened once already with
   * `livePreferences`/`liveTuiPreferences`.
   *
   * What looks obvious here is the point: it returns the OVERRIDE-APPLIED
   * table, because a `/hotkeys` list that quoted `~/.duya/config.toml`'s
   * values without telling the user they were rebound — or rebound into
   * nothing — would be describing a TUI that is not on the screen.
   */
  effectiveKeyBindings(): readonly ActionDef[] {
    return this.actionDefs;
  }

  /** F1: the keymap, rendered from the same table `bindKeys` documents. */
  private openHelpWindow(): void {
    if (this.windowOpenBlocked()) return;
    const styles = stylesOf({ theme: this.theme.tags });
    const lines: string[] = [];
    for (const group of helpGroups(this.actionDefs)) {
      lines.push(styles.accent(KEYMAP_HEADINGS[group.heading] ?? group.heading));
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
      // The rate, when the provider measured the request. A separate line
      // rather than another field on the line above: it is a different unit,
      // and it is absent for a call whose duration nobody measured.
      if (usage.tokensPerSecond !== null) {
        lines.push(`speed        ${formatTokensPerSecond(usage.tokensPerSecond)}`);
      }
    }
    lines.push(`session      ${this.sessionTokens.toLocaleString('en-US')} tokens (sum of billed calls)`);

    const budget = this.options.contextBudgetTokens?.() ?? null;
    const contextTokens = this.contextTokens();
    if (budget !== null && budget > 0 && contextTokens !== null) {
      const pct = this.contextPercent();
      lines.push(
        `context      ${this.contextBar()} ${pct}% of ${formatTokens(budget)}`
        + ` (${contextTokens.toLocaleString('en-US')} tokens in the window)`,
      );
    } else {
      lines.push(styles.muted('context      budget unknown for this model'));
    }
    this.windowMgr.open({ title: 'Token usage', lines, footer: 'Esc close' });
    this.scheduler.requestImmediate();
  }

  /**
   * Tokens the NEXT request would carry, or null when that is not known yet.
   *
   * This is the CONTEXT, and it is not the spend. The provider's usage says
   * how many tokens the last request cost; the transcript says how much has
   * been added since. The session total is a different number — every billed
   * call summed — and it grows with every turn without saying anything about
   * how full the window is. Reading it as occupancy is how a long session
   * ends up claiming a full window while the model still has room to work.
   */
  private contextTokens(): number | null {
    const usage = this.lastUsage;
    if (usage === null) return null;
    // Four characters per token is the same rough rate pi uses for the tail
    // of a conversation (`packages/ai/src/utils/estimate.ts:14`).
    const added = Math.max(0, this.model.contextChars - this.usageCharBaseline);
    return usage.total + Math.ceil(added / 4);
  }

  /** Context occupancy against the window, clamped to 0–100. */
  private contextPercent(): number {
    const budget = this.options.contextBudgetTokens?.() ?? null;
    const tokens = this.contextTokens();
    if (budget === null || budget <= 0 || tokens === null) return 0;
    return Math.min(100, Math.max(0, Math.round((tokens / budget) * 100)));
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
    focus: 'input' | 'tasks';
    selectedTaskRow: number;
  } {
    return {
      expanded: this.expanded,
      follow: this.follow,
      focus: this.focus,
      selectedTaskRow: this.selectedTaskRow,
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
    // Bound through `bindKey`, which routes to blessed's table on the blessed
    // path and to `keyHandlers` on the own one. NEVER to a Screen: `Screen.key`
    // is a delegation to `Program.key` (blessed screen.js:1726), and inline
    // mode deliberately has no Screen.
    this.bindKey(['C-c'], () => {
      if (this.interactivePrompt !== null) this.settleInteractivePrompt(null);
      else this.onCtrlC();
    });
    // Ctrl+D exits — but ONLY on an empty input, and never from under a modal.
    // See the `exit` row in `actions.ts` for why it is not delete-forward.
    this.bindKey(['C-d'], () => {
      if (this.interactivePrompt !== null || this.routeWindowControl('C-d')) return;
      if (this.overlay.isActive || this.focus !== 'input') return;
      if (!this.editor.isEmpty) return;
      this.options.onExit?.();
      this.stop();
    });
    // C-l (clear) and C-t (expand-all) are bound further down, from the
    // action table, so an override rewires them in one place.
    this.bindKey(['C-a'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(0);
      else if (this.routeWindowControl('C-a')) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveHome();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-e'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.value.length);
      else if (this.routeWindowControl('C-e')) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveEnd();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-u'], () => {
      if (this.interactivePrompt?.kind === 'text') this.updateTextPrompt({ value: this.interactivePrompt.value.slice(this.interactivePrompt.cursor), cursor: 0 });
      else if (this.routeWindowControl('C-u')) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killToStart();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-k'], () => {
      if (this.interactivePrompt?.kind === 'text') this.updateTextPrompt({ value: this.interactivePrompt.value.slice(0, this.interactivePrompt.cursor) });
      else if (this.routeWindowControl('C-k')) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killToEnd();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-w'], () => {
      if (this.interactivePrompt?.kind === 'text') {
        const before = this.interactivePrompt.value.slice(0, this.interactivePrompt.cursor).replace(/\s+$/u, '').replace(/\S+$/u, '');
        this.updateTextPrompt({ value: before + this.interactivePrompt.value.slice(this.interactivePrompt.cursor), cursor: before.length });
      } else if (this.routeWindowControl('C-w')) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.killWordBackward();
        this.refreshInputCompletion();
      }
    });
    // Undo / kill-ring yank, ported from minimax-code's editor. C-z is safe
    // to bind: blessed reads the terminal in raw mode, so the SUSP character
    // never reaches the tty line discipline to suspend the process.
    this.bindKey(['C-z'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.undo();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-y'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.yank();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['M-y'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.yankPop();
        this.refreshInputCompletion();
      }
    });
    // Clipboard attachments. Ctrl+V is also the paste chord many terminals
    // intercept (Windows Terminal pastes text itself and sends bracketed
    // paste), so Alt+V repeats the action for the terminals that never deliver
    // Ctrl+V to the application.
    this.bindKey(['C-v', 'M-v'], () => {
      if (this.swallowForWindow()) return;
      if (this.interactivePrompt === null && this.focus === 'input') {
        void this.pasteClipboardAttachment();
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
    // Full-screen mode owns its viewport, so it owns the wheel too: with mouse
    // reporting ENABLED the terminal ships the wheel as SGR sequences instead
    // of scrolling its own scrollback — and instead of a terminal like Warp
    // translating it into ↑/↓, which would recall input history. Only the
    // wheel is consumed; clicks stay with the terminal so text selection keeps
    // working.
    //
    // Inline mode deliberately does the opposite. There the terminal owns the
    // scrollback (that is the point of the mode), and the live area is only one
    // screen deep, so an app-owned scroll would have nowhere to go. Capturing
    // the wheel would take scrolling away from the one buffer that has the
    // history. The popup windows lose wheel scrolling in inline; they still
    // page with PgUp/PgDn.
    if (this.inlineSurface === null) {
      this.output.write(enableMouseReporting());
      this.onMouse((event) => {
        const action = event.action;
        if (action !== 'wheelup' && action !== 'wheeldown') return;
        if (this.interactivePrompt !== null || this.overlay.isActive) return;
        if (this.windowMgr.isActive) {
          this.windowMgr.handleKey(action === 'wheelup' ? 'up' : 'down');
          this.scheduler.requestImmediate();
          return;
        }
        this.scrollByLines(action === 'wheelup' ? -WHEEL_STEP_LINES : WHEEL_STEP_LINES);
      });
    }
    this.bindKey(['left'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.cursor - 1);
      else if (this.routeWindowArrow('left')) return;
      else if (this.interactivePrompt === null && this.focus === 'tasks') this.setTaskGroupAtSelection(true);
      else if (this.interactivePrompt === null) {
        this.editor.moveLeft();
        if (this.focus === 'input') this.refreshInputCompletion();
      }
    });
    this.bindKey(['right'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.cursor + 1);
      else if (this.routeWindowArrow('right')) return;
      else if (this.interactivePrompt === null && this.focus === 'tasks') this.setTaskGroupAtSelection(false);
      else if (this.interactivePrompt === null) {
        this.editor.moveRight();
        if (this.focus === 'input') this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-left'], () => {
      if (this.interactivePrompt === null && !this.swallowForWindow() && this.focus === 'input') {
        this.editor.moveWordLeft();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['C-right'], () => {
      if (this.interactivePrompt === null && !this.swallowForWindow() && this.focus === 'input') {
        this.editor.moveWordRight();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['home'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(0);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveHome();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['end'], () => {
      if (this.interactivePrompt?.kind === 'text') this.movePromptCursor(this.interactivePrompt.value.length);
      else if (this.swallowForWindow()) return;
      else if (this.interactivePrompt === null && this.focus === 'input') {
        this.editor.moveEnd();
        this.refreshInputCompletion();
      }
    });
    this.bindKey(['backspace'], () => {
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
    this.bindKey(['delete'], () => {
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
      this.bindKey([name], () => {
        this.routeContended(completionKey);
      });
    }

    // Shift+Tab is the panel's step-back chord (630a), so it is NOT one of the
    // CONTENDED names the popup contends with: plain `tab` is, and blessed
    // reports the shifted form under its own full name (`S-tab`, from
    // `keys.js:302`), which nothing else binds. Outside a panel the handler
    // does nothing and the text path still swallows the key by name length, so
    // the editor is left exactly where it was.
    this.bindKey(['S-tab'], () => {
      if (!this.windowMgr.isActive) return;
      this.windowMgr.handleKey('S-tab', { shift: true });
      this.scheduler.requestImmediate();
    });

    // PgUp/PgDn page the transcript in full-screen mode only. Inline mode has
    // no app-owned viewport to page: the rows above the live area are already
    // in the terminal's scrollback, and the terminal's own PgUp is the thing
    // that reaches them. Paging here would set `follow = false`, which freezes
    // the live area AND stops commits — the transcript would stop updating
    // while the agent is still streaming. Windowed popups still get the keys in
    // both modes; they own a pager of their own.
    this.bindKey(['pageup'], () => {
      if (this.interactivePrompt === null && this.windowMgr.isActive) {
        this.windowMgr.handleKey('pageup');
        this.scheduler.requestImmediate();
        return;
      }
      if (this.interactivePrompt === null && this.inlineSurface === null) this.scrollBy(-1);
    });
    this.bindKey(['pagedown'], () => {
      if (this.interactivePrompt === null && this.windowMgr.isActive) {
        this.windowMgr.handleKey('pagedown');
        this.scheduler.requestImmediate();
        return;
      }
      if (this.interactivePrompt === null && this.inlineSurface === null) this.scrollBy(1);
    });

    // Everything else is text. Notably this is where CJK arrives: measured on
    // blessed's key path a committed ideograph arrives with `key.name`
    // undefined and `ch` holding the character, so the name-keyed bindings
    // above never see it and it lands here instead.
    this.onKeypress((ch: string, key: NormalizedKey) => {
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
      // A control chord is never content. blessed's `keys` module reports
      // `\x04` as `{ name: 'd', ctrl: true }` — a ONE-character name that sails
      // past every length guard below and lands in the editor as a raw byte.
      // That both puts garbage in the prompt and makes the box non-empty, so
      // the Ctrl+D handler downstream then declines to exit. Every other
      // unbound Ctrl chord had the same bug: the byte was never visible, but
      // it silently disarmed the binding that owned it.
      if (key?.ctrl === true) {
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
        const panel = this.activeRichPanel;
        // Space is the panel's "go one level deeper / toggle this row", so it
        // is answered before the filter sees it — and only when the panel has
        // a use for it. A list with nothing to toggle reports the key back
        // unconsumed, and the space goes into the query, because `deep seek`
        // has to stay searchable.
        if (panel !== null && (name ?? ch) === 'space' && this.windowMgr.handleKey('space')) {
          this.scheduler.requestImmediate();
          return;
        }
        // In the tab strip a bound letter is a ROW ACTION, not filter text;
        // in the list the filter keeps every letter, or `install` could never
        // be typed. The strip's own keybindings are not touched by this.
        if (panel !== null
          && !panel.contentFocused()
          && panel.hasRowAction(name ?? ch)
          && panel.runRowAction(name ?? ch)) {
          this.scheduler.requestImmediate();
          return;
        }
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
      if (this.focus === 'tasks') this.focus = 'input';
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
        if (this.focus === 'tasks') this.moveTaskSelection(-1);
        else this.editor.historyPrevious();
      },
      down: () => {
        if (this.focus === 'tasks') this.moveTaskSelection(1);
        else this.editor.historyNext();
      },
      tab: () => {
        if (this.focus === 'tasks' || this.editor.isEmpty) this.toggleFocus();
        else if (this.isBusyNow() && this.options.onQueueDraft !== undefined && !isControllerLine(this.editor.text)) {
          // Tab queues only while a turn runs; otherwise it stays the editor's
          // indent, and the completion popup above still owns its accept.
          const text = this.editor.submitIfPresent();
          if (text !== null) {
            this.refreshCompletion();
            this.scheduler.requestImmediate();
            void this.options.onQueueDraft(text, this.takeDraftAttachments(text));
          }
        }
        else this.editor.insert('  ');
      },
      escape: () => {
        if (this.focus === 'tasks') this.focus = 'input';
        else if (this.completion.isOpen) this.completion.close();
        else if (this.isBusyNow()) {
          // Esc means "stop"; with prose in the composer it means "stop, then
          // send this". A command line stays put: stopping is the whole ask.
          const text = this.editor.isEmpty || isControllerLine(this.editor.text)
            ? null
            : this.editor.submitIfPresent();
          if (text !== null && this.options.onInterruptAndSend !== undefined) {
            this.refreshCompletion();
            this.options.onInterruptAndSend(text, this.takeDraftAttachments(text));
          } else this.options.onInterrupt?.();
        }
        else if (this.editor.isEmpty) {
          const queued = this.options.onRecallQueued?.();
          if (queued != null) this.recallIntoComposer(queued);
          else {
            // Nothing queued and an empty composer: adopt the predicted next
            // prompt, which then sits in the editor for the user to edit.
            const suggestion = this.options.turnSuggestion?.() ?? null;
            if (suggestion != null && suggestion.length > 0) this.recallIntoComposer(suggestion);
          }
        }
        else this.closeOverlay();
      },
      return: () => {
        if (this.focus === 'tasks') this.openSelectedTask();
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
    if (this.focus === 'tasks') this.focus = 'input';
    // A paste that is one absolute path to an attachable file becomes a chip
    // instead of text (terminal file drags arrive exactly this way). The shape
    // test is synchronous; the `stat` is not, so the fallback — pasting the
    // raw text — happens from the async continuation.
    const pathCandidate = extractPathPasteCandidate(text);
    if (pathCandidate !== null) {
      void this.acceptPathPaste(pathCandidate, text);
      return;
    }
    this.editor.insert(text);
    // Bracketed paste already tells us exactly where the payload ends, so its
    // embedded newlines are literal and must not arm the burst Enter heuristic.
    this.paste.reset();
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  /**
   * Resolve a pasted path into a draft attachment, or fall back to pasting
   * the raw text when it resolves to nothing (missing file, non-attachable
   * extension, directory).
   */
  private async acceptPathPaste(candidate: string, rawText: string): Promise<void> {
    const attachment = await resolvePathAttachment(candidate);
    if (attachment === null) {
      // Not an attachable file — the paste is ordinary text after all. The
      // burst heuristic is still reset: bracketed paste delivered this as one
      // payload, so its newlines are literal regardless of what we do with it.
      this.paste.reset();
      this.editor.insert(rawText);
      this.refreshCompletion();
      this.scheduler.requestImmediate();
      return;
    }
    this.addDraftAttachment(attachment);
  }

  /**
   * Queue an attachment and insert its chip label at the cursor.
   *
   * Returns without any effect when the draft would exceed the count or size
   * limits, or when the same file is already queued — the user sees the chip
   * not appearing rather than an error for a redundant gesture.
   */
  private addDraftAttachment(attachment: Omit<TuiDraftAttachment, 'label'>): void {
    if (this.draftAttachments.some((existing) => existing.filePath === attachment.filePath)) return;
    const violation = findAttachmentLimitViolation(this.draftAttachments, attachment.size);
    if (violation === 'count') {
      this.printError(`Attachment limit reached (${this.draftAttachments.length}/10). Submit before attaching more.`);
      return;
    }
    if (violation === 'total-size') {
      this.printError('Attachments exceed the 100 MB total limit.');
      return;
    }
    this.chipSeq += 1;
    const labelled: TuiDraftAttachment = { ...attachment, label: attachmentChipLabel(attachment, this.chipSeq) };
    this.draftAttachments.push(labelled);
    if (this.focus === 'tasks') this.focus = 'input';
    this.editor.insert(labelled.label + ' ');
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  /**
   * The attachments that travel with a draft leaving the composer.
   *
   * Attachments ride along only if their chip labels survived in the
   * submitted text; edited-away or undone chips drop their attachment here.
   * The draft list is emptied either way — the composer holds one draft.
   */
  private takeDraftAttachments(text: string): readonly FileAttachment[] {
    const attachments = takeAttachmentsForSubmit(this.draftAttachments, text);
    this.draftAttachments = [];
    return attachments;
  }

  /**
   * Open a local `!` shell card and return the callId to complete it with.
   *
   * Rendered through the ordinary bash tool card (`upsertTool` with a
   * `{ command }` input): the running spinner, the output disclosure and the
   * failure styling already exist there, and a locally-run command is visually
   * the same animal as an agent-run one.
   */
  beginLocalShell(command: string): string {
    this.localShellSeq += 1;
    const callId = `local-shell:${this.localShellSeq}`;
    this.model.upsertTool(callId, 'bash', { command });
    this.noteTranscriptMutation();
    this.scheduler.requestImmediate();
    return callId;
  }

  /** Complete a local `!` shell card with its combined output. */
  finishLocalShell(callId: string, output: string, failed: boolean): void {
    this.model.completeTool(callId, output, failed);
    this.noteTranscriptMutation();
    this.scheduler.requestImmediate();
  }

  /**
   * Read the clipboard for an image or copied files and queue what comes
   * back. Bound to Ctrl+V and Alt+V (terminals like Windows Terminal consume
   * Ctrl+V for their own text paste, which never reaches this process).
   */
  private async pasteClipboardAttachment(): Promise<void> {
    let result: Awaited<ReturnType<typeof readClipboardAttachments>>;
    try {
      result = await readClipboardAttachments();
    } catch (error) {
      this.printError('Could not read the clipboard: ' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    if (result.kind === 'empty') return;
    if (result.kind === 'unsupported') {
      this.printNotice('Clipboard attachments need Windows (Ctrl+V); paste a file path instead.');
      return;
    }
    if (result.kind === 'image') {
      const attachment = await resolveClipboardFileAttachment(result.filePath, 'image/png');
      if (attachment !== null) this.addDraftAttachment(attachment);
      return;
    }
    for (const filePath of result.paths) {
      // A copied file is explicit intent: any extension is accepted.
      const attachment = await resolveClipboardFileAttachment(filePath, null);
      if (attachment !== null) this.addDraftAttachment(attachment);
    }
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

  /**
   * Recompute the popup from the CURRENT editor state, on someone else's
   * behalf.
   *
   * An async candidate source (`plugin-candidates.ts`) can land rows while the
   * popup is already open — the user typed `@` before the inventory answered.
   * The recomputation is the same one every keystroke runs; the only new thing
   * is that it runs again after the fetch, so the rows appear without the user
   * having to type another character.
   */
  recheckCompletion(): void {
    this.refreshCompletion();
    this.scheduler.requestImmediate();
  }

  private handleOverlayKey(ch: string, key: NormalizedKey): void {
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
    // Attachments ride along only if their chip labels survived in the
    // submitted text; edited-away or undone chips drop their attachment here.
    const attachments = this.takeDraftAttachments(text);
    this.refreshCompletion();
    if (this.options.echoSubmitted !== false) {
      this.model.addUser(text);
      this.noteTranscriptMutation();
    }
    this.follow = true;
    this.scrollTop = 0;
    // Render the user's own line before the turn starts, so the transcript
    // shows what was asked rather than jumping straight to the answer.
    this.scheduler.requestImmediate();
    // A draft typed while a turn runs is guidance for that turn, not a new
    // turn behind it. The controller decides whether the run took it. Command
    // lines are exempt: they are not prose and must still reach `onSubmit`.
    if (this.isBusyNow() && this.options.onSteer !== undefined && !isControllerLine(text)) {
      void this.options.onSteer(text, attachments);
      return;
    }
    void this.options.onSubmit(text, attachments);
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
    if (this.focus === 'tasks') this.focus = 'input';
    this.follow = true;
    this.scrollTop = 0;
    this.scheduler.requestImmediate();
  }

  private toggleFocus(): void {
    if (this.focus === 'input') {
      this.openTasks();
    } else {
      this.focus = 'input';
      this.refreshCompletion();
      this.scheduler.requestImmediate();
    }
  }

  private moveTaskSelection(delta: number): void {
    const count = this.backgroundTaskRows().length;
    if (count === 0) return;
    const current = this.selectedTaskRow < 0 ? 0 : this.selectedTaskRow;
    this.selectedTaskRow = Math.max(0, Math.min(count - 1, current + delta));
    this.scheduler.requestImmediate();
  }

  /** Fold (false) or unfold (true) the group the selection sits in. */
  private setTaskGroupAtSelection(collapsed: boolean): void {
    const rows = this.backgroundTaskRows();
    const row = this.selectedTaskRow < 0 ? undefined : rows[this.selectedTaskRow];
    if (row === undefined) return;
    const group = row.kind === 'group' ? row.group : this.backgroundTasks.groups().find((g) => g.id === row.task.kind);
    if (group === undefined) return;
    this.backgroundTasks.setGroupCollapsed(group.id, collapsed);
    this.clampTaskSelection();
    this.scheduler.requestImmediate();
  }

  private openSelectedTask(): void {
    const rows = this.backgroundTaskRows();
    const row = this.selectedTaskRow < 0 ? undefined : rows[this.selectedTaskRow];
    if (row === undefined) return;
    if (row.kind === 'group') {
      this.backgroundTasks.toggleGroup(row.group.id);
      this.clampTaskSelection();
      this.scheduler.requestImmediate();
      return;
    }
    this.openTaskDetail(row.task);
  }

  /** Render the detail window; output is read on demand (Phase 8). */
  private openTaskDetail(task: BackgroundTaskView): void {
    this.options.onBackgroundTaskOpen?.(task);
  }

  private scrollBy(pages: number): void {
    const rows = this.visibleTranscriptRows();
    const total = this.transcript.totalLines(this.model, this.renderOptions());
    const maxTop = Math.max(0, total - rows);
    // `scrollTop` grows DOWNWARDS, so a negative page count (up) shrinks it.
    const current = this.follow ? maxTop : Math.min(maxTop, this.scrollTop);
    const next = Math.max(0, Math.min(maxTop, current + pages * rows));
    this.scrollTop = next;
    // Scrolling back to the newest line IS following again; scrolling away
    // from it is not. Deriving this from the offset rather than setting it
    // separately is what stops "I scrolled to the bottom but it still says
    // paused" from being reachable.
    this.follow = next >= maxTop;
    this.scheduler.requestImmediate();
  }

  /**
   * Line-granular scroll for the wheel: a page per tick is far too coarse
   * when one tick arrives per finger movement. Same follow semantics as
   * `scrollBy` — reaching the newest line resumes following.
   */
  private scrollByLines(lines: number): void {
    const total = this.transcript.totalLines(this.model, this.renderOptions());
    const maxTop = Math.max(0, total - this.visibleTranscriptRows());
    // Negative lines scroll UP: `scrollTop` counts from the top of the
    // document, so going back means a smaller number.
    const current = this.follow ? maxTop : Math.min(maxTop, this.scrollTop);
    const next = Math.max(0, Math.min(maxTop, current + lines));
    this.scrollTop = next;
    this.follow = next >= maxTop;
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

/**
 * Columns the transcript may wrap at, from the surface's own measurement.
 *
 * Falls back to the terminal width when there is no layout yet, and treats a
 * non-positive result as "no layout" rather than as a real one-column budget:
 * a zero-width wrap would put every glyph on its own line.
 */
function transcriptWidth(measured: RegionMetrics | null, fallback: number): number {
  if (measured === null || measured.width <= 0) return fallback;
  const content = measured.width - measured.innerWidth;
  return content > 0 ? content : fallback;
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

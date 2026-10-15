/**
 * The permission overlay: a codex-style list picker with a queue.
 *
 * ## Why an overlay and not a transcript line
 *
 * A permission request is a QUESTION, and the transcript is a record of what
 * already happened. Putting a question in the record means the user has to
 * scroll to find out whether they already answered it, and an answered
 * request looks exactly like an unanswered one. It also has to take focus, or
 * the keystroke that answers it goes into the prompt instead.
 *
 * ## The chain, after plan 611 Wave 4
 *
 * `headless-run-host.ts` now accepts a `requestPermission` callback on its
 * wiring, so a CLI run CAN answer. The wiring is this chain:
 *
 *   StreamingToolExecutor  →  ChatOptions.requestPermission   (the ask site)
 *     →  tui-session's handler   →  TUIApp.requestPermissionApproval
 *       →  OverlayState queue    →  the user's keys
 *
 * When no responder is wired the overlay still says so honestly rather than
 * rendering a prompt whose every answer has the same outcome.
 *
 * ## Queue semantics (codex InterruptManager, adapted)
 *
 * Parallel tool calls can raise several asks at once. Requests queue; only
 * the HEAD is interactive; answering the head reveals the next one. The body
 * reports how many are waiting so a user is never surprised by a question
 * that appears "out of nowhere" after their first answer.
 *
 * ## Destructive double-confirm (DeepSeek staging, adapted)
 *
 * A request flagged destructive (see `isDestructiveRequest`) requires Enter
 * twice on an allow choice: the first press STAGES it and the body says so,
 * the second confirms. Any navigation un-stages. Deny and cancel never
 * stage — the guard exists to slow down approval, not refusal.
 */

/** A permission decision the user can make. */
export type PermissionDecision = 'once' | 'always' | 'deny';

export interface OverlayRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly reason: string;
  readonly blockedPath?: string;
  /** The request's interactive situation, passed through for the body. */
  readonly mode?: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  /** Wall-clock deadline (`PermissionRequestEvent.expiresAt`). Absent = no timer. */
  readonly expiresAt?: number;
  /** True when the allow choices require a second Enter to confirm. */
  readonly destructive?: boolean;
}

/** One row of the picker. */
interface PickerOption {
  readonly decision: PermissionDecision | null;
  readonly key: string;
  readonly label: string;
}

/** The three choices, in picker order. Deny last — destructive staging only guards the allows. */
const PICKER: readonly PickerOption[] = [
  { decision: 'once', key: 'y', label: 'Allow once' },
  { decision: 'always', key: 'a', label: 'Always allow this session' },
  { decision: 'deny', key: 'n', label: 'Deny' },
];

/**
 * Commands whose allow choice is staged behind a second Enter.
 *
 * A HEURISTIC over the command text, and stated as one: the executor does not
 * classify destructiveness, and protocol G-2 forbids the TUI from claiming it
 * did. The list covers the operations whose accidental approval loses work —
 * recursive deletion, hard resets, forced pushes, raw device writes, and the
 * Windows/SQL equivalents. A command that is destructive and NOT matched here
 * still shows the normal picker; a matched one is never blocked, only slowed.
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\b[^|;&]*\s-{1,2}[a-z]*r/i, // rm -r / -rf / --recursive
  /\bdel\s+\/[sq]/i, // Windows del /s /q
  /\brd\s+\/s/i, // Windows rd /s
  /\bRemove-Item\b[^|;&]*-Recurse/i, // PowerShell recursive removal
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b[^|;&]*-[^a-z]*f/i, // git clean -f (and friends)
  /\bgit\s+push\b[^|;&]*(--force\b|-f\b)/i,
  /\bdd\s+if=/i,
  /\bmkfs/i,
  /\bshred\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\b(drop\s+table|truncate\s+table)\b/i,
];

/** Heuristic destructive classifier for the approval picker. */
export function isDestructiveRequest(toolName: string, toolInput: unknown): boolean {
  const name = toolName.toLowerCase();
  // Only execution-shaped tools carry a command to inspect. A Write to a path
  // is destructive in the abstract, but the picker has no workspace boundary
  // to judge it against, and flagging every write would train the user to
  // double-Enter everything — which is the same as staging nothing.
  const isCommandTool = name === 'bash' || name === 'execute' || name === 'shell' || name === 'command';
  if (!isCommandTool) return false;
  const input = toolInput as Record<string, unknown> | null;
  const command = typeof input?.command === 'string' ? input.command : '';
  if (command === '') return false;
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/** Render the tool input compactly, without a full JSON dump. */
function summariseInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return String(input);
  }
}

/** What the body needs beyond the request itself. */
export interface OverlayView {
  /** Zero-based picker selection. */
  readonly selectedIndex: number;
  /** Set when a destructive allow choice is staged for a second Enter. */
  readonly staged: boolean;
  /** Requests queued behind the head. */
  readonly queueDepth: number;
}

/** The overlay's body, as blessed tags. */
export function renderOverlay(
  request: OverlayRequest,
  answerable: boolean,
  view: OverlayView = { selectedIndex: 0, staged: false, queueDepth: 0 },
): string {
  const lines: string[] = [];
  lines.push(`{bold}{yellow-fg}Permission required{/yellow-fg}{/bold}`);
  lines.push(`tool: {cyan-fg}${request.toolName}{/cyan-fg}`);

  const input = summariseInput(request.toolInput);
  if (input !== '') lines.push(`input: {gray-fg}${input}{/gray-fg}`);
  if (request.reason !== '') lines.push(`reason: {gray-fg}${request.reason}{/gray-fg}`);
  if (request.blockedPath !== undefined && request.blockedPath !== '') {
    lines.push(`path: {gray-fg}${request.blockedPath}{/gray-fg}`);
  }

  if (answerable) {
    lines.push('');
    PICKER.forEach((option, index) => {
      const marker = index === view.selectedIndex ? '{cyan-fg}❯{/cyan-fg}' : ' ';
      const stagedNote = option.decision !== 'deny' && view.staged
        && view.selectedIndex === index
        ? '  {yellow-fg}press Enter again to confirm{/yellow-fg}'
        : '';
      lines.push(`${marker} [${index + 1}] ${option.label} (${option.key})${stagedNote}`);
    });
    if (request.destructive === true) {
      lines.push('{gray-fg}destructive command — allows need a second Enter{/gray-fg}');
    }
    if (view.queueDepth > 0) {
      lines.push(`{gray-fg}+${view.queueDepth} more request${view.queueDepth === 1 ? '' : 's'} waiting{/gray-fg}`);
    }
    lines.push('');
    lines.push('{gray-fg}↑/↓ choose · Enter confirm · 1-3 / y/a/n quick-pick · Esc deny all{/gray-fg}');
  } else {
    // Without a responder every key does the same thing, so the overlay says
    // so instead of pretending to offer a choice.
    lines.push('');
    lines.push('{red-fg}no permission responder is attached to this run; this request cannot be answered here{/red-fg}');
  }

  return lines.join('\n');
}

interface QueuedAsk {
  readonly request: OverlayRequest;
  readonly resolve: (decision: PermissionDecision | null) => void;
}

/**
 * Queue of permission asks with a picker state for the head.
 *
 * `show` keeps its historical signature and semantics — enqueue, then settle
 * via `decide` — so the frame-driven path and the promise-driven path share
 * one lifecycle.
 */
export class OverlayState {
  private current: OverlayRequest | null = null;
  private resolver: ((decision: PermissionDecision | null) => void) | null = null;
  /** Asks waiting behind the head. Only the head is interactive. */
  private readonly queue: QueuedAsk[] = [];
  /** Picker state for the head request. */
  private selectedIndex = 0;
  private staged = false;
  /** The head's expiry timer, cleared on every settle. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** True while the overlay is on screen. */
  get isActive(): boolean {
    return this.current !== null;
  }

  /** The request on screen, if any. */
  get request(): OverlayRequest | null {
    return this.current;
  }

  /** Requests waiting behind the head. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Current picker selection, for tests and the body. */
  get selection(): number {
    return this.selectedIndex;
  }

  /** True when a destructive allow choice is staged. */
  get isStaged(): boolean {
    return this.staged;
  }

  /** Body to render, or `null` when the overlay is closed. */
  body(answerable: boolean): string | null {
    if (this.current === null) return null;
    return renderOverlay(this.current, answerable, {
      selectedIndex: this.selectedIndex,
      staged: this.staged,
      queueDepth: this.queue.length,
    });
  }

  /**
   * Queue a request; `onDecision` settles when the user answers it, it times
   * out, or it is cancelled.
   */
  show(request: OverlayRequest, onDecision: (decision: PermissionDecision | null) => void): void {
    this.queue.push({ request, resolve: onDecision });
    if (this.current === null) this.advance();
  }

  /**
   * Answer the head request.
   *
   * A decision made with no request open is ignored rather than thrown: the
   * key handler is bound to the screen, so a stray keypress after close would
   * otherwise take down the turn.
   */
  decide(decision: PermissionDecision | null): void {
    if (this.current === null) return;
    this.clearTimer();
    const settle = this.resolver;
    this.current = null;
    this.resolver = null;
    this.selectedIndex = 0;
    this.staged = false;
    settle?.(decision);
    this.advance();
  }

  /**
   * Cancel the head AND everything queued, resolving each with `null`.
   *
   * The frame-driven path calls this before showing a fresh request: a new
   * `permission` frame supersedes whatever stale asks are still open, and
   * leaving them queued would surface questions the run has already moved
   * past.
   */
  abortAll(): void {
    // Drained manually rather than via `decide(null)`: `decide` would promote
    // the next queued ask to head, and the loop below would then never see it.
    const head = this.current !== null && this.resolver !== null
      ? [{ request: this.current, resolve: this.resolver }]
      : [];
    this.clearTimer();
    this.current = null;
    this.resolver = null;
    this.selectedIndex = 0;
    this.staged = false;
    const pending = [...head, ...this.queue.splice(0, this.queue.length)];
    for (const ask of pending) ask.resolve(null);
  }

  /**
   * One key against the head picker.
   *
   * Keys that mean nothing to the overlay are reported as unhandled so the
   * caller can keep swallowing them (they must not reach the prompt under a
   * modal) without the picker jumping on stray input.
   */
  handleKey(input: { readonly name?: string; readonly ch?: string }): boolean {
    if (this.current === null) return false;
    const name = input.name ?? input.ch ?? '';

    // Direct decision keys: quick-pick selects the row, then honours staging.
    const pickIndex = ['y', 'a', 'n', '1', '2', '3'].indexOf(name);
    if (pickIndex !== -1) {
      const index = pickIndex < 3 ? pickIndex : pickIndex - 3;
      return this.pick(index);
    }

    if (name === 'up' || name === 'k') {
      this.selectedIndex = (this.selectedIndex + PICKER.length - 1) % PICKER.length;
      this.staged = false;
      return true;
    }
    if (name === 'down' || name === 'j') {
      this.selectedIndex = (this.selectedIndex + 1) % PICKER.length;
      this.staged = false;
      return true;
    }
    if (name === 'return' || name === 'enter') {
      return this.pick(this.selectedIndex);
    }
    if (name === 'escape') {
      this.decide(null);
      return true;
    }
    return false;
  }

  /**
   * Select a picker row, honouring destructive staging.
   *
   * Deny never stages. An allow on a destructive request stages on the first
   * press — selecting the SAME row again (via its key or Enter) confirms.
   */
  private pick(index: number): boolean {
    const option = PICKER[index];
    if (option === undefined) return false;
    const destructiveAllow = option.decision !== 'deny' && option.decision !== null
      && this.current?.destructive === true;
    if (destructiveAllow && !(this.staged && this.selectedIndex === index)) {
      this.selectedIndex = index;
      this.staged = true;
      return true;
    }
    this.decide(option.decision);
    return true;
  }

  /** Promote the next queued ask, if any. */
  private advance(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    this.current = next.request;
    this.resolver = next.resolve;
    this.selectedIndex = 0;
    this.staged = false;
    this.armTimer(next.request);
  }

  /**
   * Arm the request's own deadline, if it carried one.
   *
   * The executor stamps `expiresAt` (five minutes) on every ask; a timer here
   * means an abandoned prompt settles as `null` (deny at the wiring) instead
   * of blocking the turn forever. The delay is clamped into `setTimeout`'s
   * 32-bit range.
   */
  private armTimer(request: OverlayRequest): void {
    if (request.expiresAt === undefined) return;
    const delay = Math.max(0, Math.min(request.expiresAt - Date.now(), 2_147_000_000));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.decide(null);
    }, delay);
    // Never hold the process open for a permission timer.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

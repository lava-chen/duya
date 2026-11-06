/**
 * Terminal integrations beyond the window title: cwd, clipboard, desktop
 * notifications and taskbar progress.
 *
 * ## Why this module and not `ansi.ts`
 *
 * `ansi.ts` owns the vocabulary — the bytes. This module owns the POLICY, and
 * the policy is where these features differ from a title:
 *
 * - **Payloads are untrusted.** A notification body or a copied assistant
 *   reply can contain a BEL or an ESC, which terminates the OSC early and
 *   spills the remainder into the terminal as input. Every payload is
 *   sanitised or base64-encoded before it reaches a sequence constructor.
 * - **Two of them have visible side effects outside the terminal.** A desktop
 *   notification can pop over another window and a bell can be heard. They are
 *   opt-in (`DUYA_TUI_NOTIFY=1` / `DUYA_TUI_PROGRESS=1`), never on by default.
 * - **OSC 9;4 shares its prefix with OSC 9 notification.** A terminal that
 *   reads `9;4;2;0` as `9;<body>` shows a garbage notification instead of a
 *   progress bar. Progress is therefore hard-gated on Windows Terminal, not
 *   merely on a capability guess; everywhere else the sequence is not built.
 * - **tmux swallows OSC sequences.** Sequences meant for the OUTER terminal
 *   (clipboard, notification, progress, cwd) are wrapped in DCS passthrough.
 *   The window title is deliberately not: tmux interprets OSC 0 itself to
 *   rename its window, which is the behaviour we want there.
 *
 * ## Why the caches exist
 *
 * Writes to these channels are not idempotent from the user's point of view:
 * an identical cwd repaints tab chrome, an identical progress state restarts
 * an animation, and a repeated notification is noise. `codex`'s
 * `terminal_program_status.rs` ties the write and the cache update together —
 * a failed write leaves the cache untouched so the next call retries. That is
 * the rule here too.
 */

import { hostname } from 'node:os';

import {
  bell,
  desktopNotification,
  itermNotification,
  reportWorkingDirectory,
  setClipboard,
  setProgress,
  type TerminalProgressState,
} from './terminal/ansi.js';
import type { TerminalProgram } from './terminal-env.js';

export type { TerminalProgressState } from './terminal/ansi.js';

/**
 * OSC 52 payload cap, in UTF-8 bytes of the TEXT (before base64).
 *
 * A whole assistant reply can be tens of kilobytes. Terminals cap the OSC
 * body they are willing to parse (and a few truncate it silently, leaving a
 * half-written clipboard), so a copy that large is refused and falls through
 * to the native clipboard tool instead.
 */
export const MAX_CLIPBOARD_BYTES = 64 * 1024;

/**
 * Notification body cap, in UTF-8 bytes.
 *
 * Ghostty copies the body into a 255-byte buffer; a body cut mid-codepoint is
 * worse than a short one, so truncation walks back to a UTF-8 boundary and
 * appends an ellipsis.
 */
export const MAX_NOTIFICATION_BYTES = 255;

/** Two identical notifications closer than this are one notification. */
export const NOTIFY_THROTTLE_MS = 1000;

export interface TerminalIntegrationFlags {
  /** OSC 7: new tabs inherit the session's working directory. */
  readonly cwd: boolean;
  /** OSC 52: `/copy` over SSH / tmux reaches the local clipboard. */
  readonly clipboard: boolean;
  /** OSC 9 / OSC 777 / BEL. Off unless explicitly enabled. */
  readonly notify: boolean;
  /** OSC 9;4. Off unless explicitly enabled AND Windows Terminal. */
  readonly progress: boolean;
}

const ALL_OFF: TerminalIntegrationFlags = {
  cwd: false,
  clipboard: false,
  notify: false,
  progress: false,
};

/**
 * Resolve the four switches from the environment.
 *
 * `DUYA_TUI_TERMINAL_INTEGRATION=0` is the master switch for shell wrappers
 * and CI: no OSC integration at all, including the ones that are otherwise
 * on by default. `TERM=dumb` gets the same treatment — a dumb terminal has no
 * OSC parser, and raw `]7;...` bytes in a log are worse than no integration.
 *
 * `cwd` and `clipboard` default ON because they only fire on a directory
 * change and on an explicit `/copy`. `notify` and `progress` default OFF.
 */
export function terminalIntegrationFlags(
  env: NodeJS.ProcessEnv = process.env,
  program: TerminalProgram = 'unknown',
): TerminalIntegrationFlags {
  if (env['DUYA_TUI_TERMINAL_INTEGRATION'] === '0' || env['TERM'] === 'dumb') return ALL_OFF;
  return {
    cwd: env['DUYA_TUI_CWD'] !== '0',
    clipboard: env['DUYA_TUI_CLIPBOARD'] !== '0',
    notify: env['DUYA_TUI_NOTIFY'] === '1',
    progress: env['DUYA_TUI_PROGRESS'] === '1' && program === 'windows-terminal',
  };
}

/**
 * Build an OSC 7 `file:` URI from a filesystem path.
 *
 * Windows drive paths need a leading slash (`C:\a` => `/C:/a`), every segment
 * is percent-encoded (spaces and CJK directory names are common here), and
 * the hostname is encoded too. UNC paths keep their server in the path rather
 * than pretending it is the local host — a wrong authority is worse than an
 * unresolvable but honest one.
 */
export function osc7Uri(
  cwd: string,
  host: string = hostname(),
  platform: NodeJS.Platform = process.platform,
): string {
  const slashed = platform === 'win32' ? cwd.replace(/\\/gu, '/') : cwd;
  const drive = platform === 'win32' && /^[A-Za-z]:\//u.test(slashed) ? `/${slashed}` : slashed;
  const encoded = drive
    .split('/')
    // A drive letter's colon separates the drive from the path, it is not a
    // character in a filename: `C%3A` is not a URI most terminals resolve.
    .map((segment) => (/^[A-Za-z]:$/u.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  const path = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return `file://${encodeURIComponent(host)}${path}`;
}

/**
 * Fold untrusted notification text into one bounded line.
 *
 * Control characters (including the BEL/ESC that would close the OSC early)
 * become spaces; whitespace collapses; the UTF-8 truncation backs off to a
 * codepoint boundary. Invisible bidi/zero-width formatting is dropped for the
 * same Trojan-Source reason as in `terminal-title.ts`.
 */
export function sanitizeNotification(raw: string, maxBytes = MAX_NOTIFICATION_BYTES): string {
  const clean = raw
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
    .replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= maxBytes) return clean;
  let cut = maxBytes - 3; // room for the UTF-8 ellipsis
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return `${bytes.subarray(0, cut).toString('utf8')}…`;
}

export type NotificationBackend = 'osc9' | 'iterm' | 'bell';

/**
 * Pick a notification form the terminal actually understands.
 *
 * iTerm2 gets its titled OSC 777 form. kitty and WezTerm get OSC 9. Windows
 * Terminal does NOT support OSC 9 notifications (only the unrelated 9;4
 * progress form), VS Code ignores them, and an unnamed terminal gets no
 * benefit of the doubt — all of those fall back to a plain bell, which is
 * audible but cannot be misread as a title change.
 */
export function notificationBackend(program: TerminalProgram): NotificationBackend {
  if (program === 'iterm2') return 'iterm';
  if (program === 'kitty' || program === 'wezterm') return 'osc9';
  return 'bell';
}

/** The bytes for an already-sanitised notification body. */
export function notificationSequence(body: string, program: TerminalProgram): string {
  const backend = notificationBackend(program);
  if (backend === 'iterm') return itermNotification(body);
  if (backend === 'osc9') return desktopNotification(body);
  return bell();
}

/**
 * Build a progress sequence ONLY for Windows Terminal.
 *
 * This is a second, independent gate from the flags check: a caller that
 * forgets to check `program` still cannot emit `9;4;...` into a terminal that
 * would read it as a notification.
 */
export function progressSequence(
  state: TerminalProgressState,
  program: TerminalProgram,
  value = 0,
): string | null {
  if (program !== 'windows-terminal') return null;
  return setProgress(state, value);
}

/**
 * Wrap a sequence for the terminal OUTSIDE tmux.
 *
 * tmux consumes OSC sequences itself. The documented passthrough is DCS
 * `ESC P tmux; <payload> ESC \` with every ESC in the payload doubled —
 * doubling is what stops tmux from treating an embedded ST or ESC as the end
 * of its own DCS string. `codex` does this for notifications; we do it for
 * every integration except the window title (see the file header).
 */
export function tmuxPassthrough(sequence: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env['TMUX'] !== 'string' || env['TMUX'] === '') return sequence;
  const doubled = sequence.split('\x1b').join('\x1b\x1b');
  return `\x1bPtmux;${doubled}\x1b\\`;
}

/** What a terminal-bound OSC write needs. Structurally the title's writer. */
export interface TerminalOscWriter {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface TerminalIntegrationOptions {
  readonly writer: TerminalOscWriter;
  /** Named terminal; decides notification backend and the progress gate. */
  readonly program?: TerminalProgram;
  readonly env?: NodeJS.ProcessEnv;
  /** Override resolved flags. Tests use this instead of mutating process.env. */
  readonly flags?: Partial<TerminalIntegrationFlags>;
  /** Override the tty check. Tests use this. */
  readonly enabled?: boolean;
  readonly host?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

/** Writes the four integrations, de-duplicated and gated. */
export class TerminalIntegration {
  readonly flags: TerminalIntegrationFlags;

  private readonly writer: TerminalOscWriter;
  private readonly program: TerminalProgram;
  private readonly env: NodeJS.ProcessEnv;
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  private lastCwd: string | null = null;
  private lastProgress: string | null = null;
  private lastNotify: { readonly body: string; readonly at: number } | null = null;

  constructor(options: TerminalIntegrationOptions) {
    this.writer = options.writer;
    this.program = options.program ?? 'unknown';
    this.env = options.env ?? process.env;
    this.flags = { ...terminalIntegrationFlags(this.env, this.program), ...options.flags };
    // The writer used for rendering claims `isTTY: true` unconditionally so
    // blessed-style consumers keep working; this one is given the RAW output
    // stream so a pipe never receives OSC bytes.
    this.enabled = options.enabled ?? options.writer.isTTY === true;
    this.host = options.host ?? hostname();
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  /** Returns whether bytes were sent. A thrown write leaves the cache intact. */
  private emit(sequence: string): boolean {
    if (!this.enabled) return false;
    try {
      this.writer.write(tmuxPassthrough(sequence, this.env));
      return true;
    } catch {
      return false;
    }
  }

  /** OSC 7: tell the terminal which directory new tabs should open in. */
  reportCwd(cwd: string): boolean {
    if (!this.flags.cwd) return false;
    const uri = osc7Uri(cwd, this.host, this.platform);
    if (uri === this.lastCwd) return false;
    if (!this.emit(reportWorkingDirectory(uri))) return false;
    this.lastCwd = uri;
    return true;
  }

  /**
   * OSC 52: send text to the clipboard of the machine the TERMINAL runs on.
   *
   * Returns whether the sequence was sent, not whether the terminal accepted
   * it — there is no portable acknowledgement for OSC 52. Callers must say
   * "sent", and must keep their native-tool fallback for terminals that do
   * not implement it.
   */
  copy(text: string): boolean {
    if (!this.flags.clipboard || text === '') return false;
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_CLIPBOARD_BYTES) return false;
    return this.emit(setClipboard(bytes.toString('base64')));
  }

  /** A desktop notification, throttled and de-duplicated. */
  notify(body: string): boolean {
    if (!this.flags.notify) return false;
    const clean = sanitizeNotification(body);
    if (clean === '') return false;
    const at = this.now();
    if (this.lastNotify?.body === clean && at - this.lastNotify.at < NOTIFY_THROTTLE_MS) return false;
    if (!this.emit(notificationSequence(clean, this.program))) return false;
    this.lastNotify = { body: clean, at };
    return true;
  }

  /** OSC 9;4 progress. `state: 0` removes the indicator. */
  progress(state: TerminalProgressState, value = 0): boolean {
    if (!this.flags.progress) return false;
    const sequence = progressSequence(state, this.program, value);
    if (sequence === null) return false;
    if (state === 0 && this.lastProgress === null) return false;
    const key = `${state}:${Math.max(0, Math.min(100, Math.round(value)))}`;
    if (state !== 0 && key === this.lastProgress) return false;
    if (!this.emit(sequence)) return false;
    this.lastProgress = state === 0 ? null : key;
    return true;
  }

  /**
   * Forget what was written, so the next call re-sends.
   *
   * Needed when another process may have taken over the terminal (a shell
   * command inside the TUI) — the bytes we sent are still in our cache but no
   * longer describe what the terminal believes.
   */
  invalidate(): void {
    this.lastCwd = null;
    this.lastProgress = null;
    this.lastNotify = null;
  }

  /** Remove a progress indicator on exit; never leaves a stale tab badge. */
  dispose(): void {
    if (this.lastProgress !== null) this.progress(0);
    this.invalidate();
  }
}

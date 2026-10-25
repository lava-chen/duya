/**
 * The working tail: the one row that says the agent is doing something.
 *
 * ## Why this is its own module and not a status-bar field
 *
 * The activity data was already there — the running tool, its elapsed time, the
 * subagent, the phase — all of it crammed into the single status line, where it
 * overwrites itself and where there is no room to animate. codex, claude and
 * minimax all show the same thing as a live row that sits under the last
 * message and moves while the turn runs.
 *
 * ## Where it lives, and why that is the whole point
 *
 * The tail is CHROME, not transcript. That is not a layout preference. A
 * transcript row is committed to the terminal's scrollback the moment it leaves
 * the live area, permanently — so a spinner row that went into the transcript
 * would leave a line of braille in the user's history where a tool call
 * happened. It has to be a row the surface rewrites and blanks, which is
 * exactly what chrome already is.
 *
 * ## Why a timer at all
 *
 * The render scheduler throttles to `MIN_RENDER_INTERVAL_MS`, and nothing
 * redraws a static frame. Without a clock advancing the frame index, "working"
 * is a single glyph that never moves, which reads as a hang rather than as
 * progress. The timer only advances an index and asks for a THROTTLED render —
 * it never paints.
 */

import { compactActivity } from './text.js';

/** Braille dots, in rotation order. Reads as motion at a terminal's refresh. */
export const SPINNER_UNICODE: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Fallback for a terminal that cannot be trusted with braille.
 *
 * **No backslash, no braces.** Every one of these glyphs is concatenated straight
 * into `{cyan-fg}<glyph>{/cyan-fg}` and then parsed by `tagsToAnsi`, where `\{` is
 * the escape for a literal brace. A `\` glyph therefore reads as an escape
 * marker, the brace after it prints literally, and the frame comes out as
 * `\x1b[36m{/cyan-fg}` — a spinner row with half a colour tag in it. That bug
 * was measured, not reasoned about, which is why the set below is asserted in
 * `working-tail.test.ts` rather than left to review.
 */
export const SPINNER_ASCII: readonly string[] = ['.', 'o', 'O', '@'];

/**
 * How often the frame advances.
 *
 * 90ms is deliberately not the render interval. The scheduler throttles at 70ms,
 * so a faster clock here would queue renders that the throttle then collapses —
 * more wakeups, no more motion.
 */
export const WORKING_TAIL_INTERVAL_MS = 90;

/**
 * The next frame index.
 *
 * Wrapping rather than clamping: a spinner that sticks on its last glyph is the
 * one thing a spinner must never do.
 */
export function nextSpinnerFrame(current: number, unicode: boolean): number {
  const frames = unicode ? SPINNER_UNICODE : SPINNER_ASCII;
  const index = Number.isFinite(current) ? Math.trunc(current) : 0;
  return ((((index + 1) % frames.length) + frames.length) % frames.length);
}

/** Glyph currently shown for a frame index, keeping every surface in sync. */
export function spinnerGlyph(frame: number, unicode: boolean): string {
  const frames = unicode ? SPINNER_UNICODE : SPINNER_ASCII;
  return frames[nextSpinnerFrame(frame, unicode)] ?? frames[0] ?? '';
}

export interface WorkingTailOptions {
  /** Current frame index. */
  readonly frame: number;
  /** What the agent is doing, e.g. `read_file (2s)`. */
  readonly label: string;
  readonly unicode: boolean;
  /** Terminal width. The line is fitted to it — see the wrapping note. */
  readonly columns: number;
  /**
   * False when the row is shown for background work while the turn itself is
   * idle. The glyph then is a static dot: a spinner that keeps turning with
   * nothing running reads as a hang.
   */
  readonly active?: boolean;
}

/** Static glyph for an idle row that still has live background work. */
export const IDLE_TASK_GLYPH_UNICODE = '•';
export const IDLE_TASK_GLYPH_ASCII = '*';

export interface BackgroundSummaryCounts {
  /** Background bash processes still running. */
  readonly bashRunning: number;
  /** Subagents still running. */
  readonly subagentRunning: number;
  /** Every tracked task, terminal ones included. */
  readonly totalTasks: number;
}

/**
 * Compose the summary segments after the activity label.
 *
 * The counts are the RUNNING ones: a task list that says "2 background" after
 * both finished would be a claim about work in flight that is not there.
 * `/tasks details` appears whenever there is anything at all to inspect, which
 * is the one thing a user needs when the counts have gone quiet.
 */
export function backgroundSummarySuffix(counts: BackgroundSummaryCounts): string {
  const parts: string[] = [];
  if (counts.bashRunning > 0) parts.push(`${counts.bashRunning} background`);
  if (counts.subagentRunning > 0) parts.push(`${counts.subagentRunning} subagent`);
  if (counts.totalTasks > 0) parts.push('/tasks details');
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}

/**
 * One line of blessed markup for the tail.
 *
 * The width fit happens on PLAIN TEXT, before any tag goes on. Fitting a line
 * that already carries markup counts the tag as characters and can cut one in
 * half, leaving the terminal in the previous colour for the rest of the row.
 *
 * The budget leaves one column spare. A line that exactly fills the width is the
 * one that wraps, and a wrapped row inside the live area pushes every row below
 * it — which was measured happening on Windows ConPTY, where the frame-level
 * `?7l` that is supposed to prevent exactly that is ignored.
 */
export function workingTailLine(options: WorkingTailOptions): string {
  const glyph = options.active === false
    ? (options.unicode ? IDLE_TASK_GLYPH_UNICODE : IDLE_TASK_GLYPH_ASCII)
    : spinnerGlyph(options.frame, options.unicode);
  const width = Math.max(8, options.columns - 1);
  const label = compactActivity(options.label, Math.max(1, width - glyph.length - 1));
  return `{cyan-fg}${glyph}{/cyan-fg} ${label}`;
}

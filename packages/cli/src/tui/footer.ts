/**
 * The two-row footer under the composer.
 *
 * ## Why this shape
 *
 * Ported from pi's `FooterComponent`: the row directly under the input box is
 * the *where*, and the row under that is the *how much* — left-aligned totals,
 * right-aligned model. Two rows, never three, because the footer is chrome and
 * every row it takes is a row the conversation does not get.
 *
 * The split is deliberate rather than cosmetic. A single status row has to
 * compete for its width between the path (long, structural), the token
 * counters (short, numeric) and the model name (short, identifying), and on a
 * narrow terminal something important always loses. Splitting them lets the
 * path truncate while the numbers never do.
 *
 * ## Widths are computed on plain text, then tagged
 *
 * Every row is measured BEFORE a tag is applied. `{gray-fg}` is eleven columns
 * to a naive `length` and zero to the terminal, so measuring a tagged string is
 * exactly how a right-aligned column ends up ragged by the length of its own
 * escape codes. Clipping happens on the plain text and the colour is applied
 * afterwards, which also means there is no escape-sequence surgery anywhere in
 * this file.
 *
 * ## A row must never wrap
 *
 * The footer is the bottom of the live area. A row that overflows its width
 * wraps, pushes everything below it down, and lands off-screen — the one
 * failure that makes an inline TUI look broken rather than ugly. Every row is
 * therefore hard-clamped to `width`, with `width` already one column short of
 * the terminal (see the caller).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Styles } from './transcript-view.js';
import { visibleWidth } from './width.js';

/** Counters shown on the footer's second row. */
export interface FooterStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Sum of every billed call this session. */
  readonly totalTokens: number;
  /** 0–100, or null when no context budget is known for the model. */
  readonly contextPercent: number | null;
  readonly contextBudget: number | null;
  /**
   * Output tokens per second of the most recent billed call, or null when
   * the provider reported no duration for it.
   *
   * Null and zero are different answers: null means "nobody measured this
   * call", zero would mean "the model emitted nothing in no time", which is
   * not a rate anybody observed.
   */
  readonly outputTokensPerSecond: number | null;
}

/** The right-hand identity of the second row. */
export interface FooterModel {
  readonly provider?: string;
  readonly model: string;
  readonly thinking?: string;
}

export interface FooterInput {
  readonly width: number;
  readonly cwd: string;
  readonly branch?: string | null;
  readonly sessionName?: string | null;
  /** Contextual key hint, right-aligned on the first row. */
  readonly hint?: string;
  readonly stats: FooterStats;
  readonly model?: FooterModel | null;
  readonly styles: Styles;
  /** `HOME`/`USERPROFILE`, for `~` substitution. */
  readonly home?: string;
}

/** Between the groups on the stats row: one column each side, like the hints. */
const SEPARATOR = ' · ';

/** Human token count: `940`, `12.3k`, `1.2M` — pi's thresholds. */
export function formatTokenCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

/**
 * Measured output throughput: `7.4 tok/s`.
 *
 * One decimal, because the difference between 12 and 13 tok/s is noise and
 * the difference between 12 and 120 is not. No `~` prefix: this number is
 * measured against the provider's own request duration, not estimated from
 * streamed text.
 *
 * Plain text on purpose, no decorative glyph. This label rides the right edge
 * of the footer, where a width the table under-measures is not a cosmetic
 * slip but the row's last character being pushed onto ConPTY's final column
 * and clipped — `⚡` measured 1 cell in the width table while Windows Terminal
 * drew 2, and `medium` reached the user as `mediu` (2026-10-25). The accent
 * colour already sets this group apart; it does not need an emoji too.
 */
export function formatTokensPerSecond(rate: number): string {
  return `${rate.toFixed(1)} tok/s`;
}

/**
 * Replace a path under the home directory with `~`.
 *
 * Only a path that is genuinely INSIDE home is rewritten: `~` for a sibling
 * directory that merely shares a name prefix (`/home/ann` vs `/home/anna`)
 * would print a path that does not exist.
 */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (home === undefined || home === '') return cwd;
  let resolvedCwd: string;
  let resolvedHome: string;
  try {
    resolvedCwd = resolve(cwd);
    resolvedHome = resolve(home);
  } catch {
    return cwd;
  }
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome = relativeToHome === ''
    || (relativeToHome !== '..'
      && !relativeToHome.startsWith(`..${sep}`)
      && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === '' ? '~' : `~${sep}${relativeToHome}`;
}

/**
 * The current git branch of `directory`, read from `.git/HEAD`.
 *
 * Read rather than shelled out to: the footer repaints on every frame, and a
 * `git` child process per frame is not a footer, it is a load test. A file read
 * is also right in the cases that matter — a detached HEAD yields the short
 * hash, and a worktree's `.git` FILE yields the branch of the real repository.
 *
 * Returns null for "no repository, or nothing readable"; the footer then omits
 * the parenthesised part, which is also what pi does.
 */
export function readGitBranch(directory: string): string | null {
  let current: string;
  try {
    current = resolve(directory);
  } catch {
    return null;
  }

  for (let depth = 0; depth < 40; depth += 1) {
    const branch = branchAt(current);
    if (branch !== null) return branch;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** The branch a `.git` entry in `directory` points HEAD at, or null. */
function branchAt(directory: string): string | null {
  const gitPath = join(directory, '.git');
  let isDirectory: boolean;
  try {
    isDirectory = statSync(gitPath).isDirectory();
  } catch {
    return null;
  }
  if (isDirectory) return branchFromHeadFile(join(gitPath, 'HEAD'));

  // A worktree (and a submodule) keeps `.git` as a FILE: `gitdir: <path>`.
  try {
    const pointer = readFileSync(gitPath, 'utf8').trim();
    const target = pointer.startsWith('gitdir:') ? pointer.slice('gitdir:'.length).trim() : '';
    if (target === '') return null;
    const resolved = isAbsolute(target) ? target : join(directory, target);
    return branchFromHeadFile(join(resolved, 'HEAD'));
  } catch {
    return null;
  }
}

function branchFromHeadFile(headPath: string): string | null {
  let head: string;
  try {
    head = readFileSync(headPath, 'utf8').trim();
  } catch {
    return null;
  }
  const prefix = 'ref: refs/heads/';
  if (head.startsWith(prefix)) return head.slice(prefix.length);
  // Detached HEAD: the file holds a raw object id.
  if (/^[0-9a-f]{7,40}$/iu.test(head)) return head.slice(0, 7);
  return null;
}

/**
 * Two footer rows, tagged, each at most `width` visible columns.
 *
 * Row 1 is where the session is; row 2 is what it costs and which model is
 * paying. The hint rides the right of row 1 because it is transient and loses
 * nothing when truncated — unlike the numbers on row 2, which are the point.
 */
export function buildFooterLines(input: FooterInput): string[] {
  const width = Math.max(1, Math.floor(input.width));
  const styles = input.styles;

  const location = formatCwdForFooter(input.cwd, input.home);
  const branch = input.branch ?? null;
  const withBranch = branch === null || branch === '' ? location : `${location} (${branch})`;
  const withSession = input.sessionName === undefined || input.sessionName === null || input.sessionName === ''
    ? withBranch
    : `${withBranch} • ${input.sessionName}`;

  const stats = input.stats;
  const counters: string[] = [];
  if (stats.inputTokens > 0) counters.push(`↑${formatTokenCount(stats.inputTokens)}`);
  if (stats.outputTokens > 0) counters.push(`↓${formatTokenCount(stats.outputTokens)}`);
  if (stats.totalTokens > 0) counters.push(`Σ${formatTokenCount(stats.totalTokens)}`);

  const budget = stats.contextBudget ?? null;
  const percent = stats.contextPercent;
  // `?` before the first billed call, like pi: the window size is known, the
  // usage is not, and a confident "0%" would be a claim rather than a reading.
  const contextLabel = budget !== null && budget > 0
    ? `${percent === null ? '?' : `${Math.round(percent)}%`}/${formatTokenCount(budget)}`
    : '';
  // The output rate of the MOST RECENT billed call, measured against the
  // provider's own request duration. It is omitted entirely when the provider
  // reported no duration, rather than shown as a zero.
  const rate = stats.outputTokensPerSecond;
  const rateLabel = rate !== null && Number.isFinite(rate) ? formatTokensPerSecond(rate) : '';

  // Three GROUPS, not a run of bare tokens. The counters answer "what has this
  // session spent", the context pair "how much of the window is left", the rate
  // "how fast did the last answer come". Single spaces made five numbers of
  // three different kinds read as one undifferentiated run, which is the shape
  // this row was criticised for; the separator and one colour per kind are what
  // tell them apart without adding a row or a label.
  const groups = [counters.join(' '), contextLabel, rateLabel].filter((group) => group !== '');
  const statsPlain = groups.join(SEPARATOR);

  const model = input.model ?? null;
  const provider = model?.provider === undefined || model.provider === '' ? '' : `(${model.provider}) `;
  const thinking = model?.thinking === undefined || model.thinking === '' ? '' : ` • ${model.thinking}`;
  const modelPlain = model === null ? '' : `${provider}${model.model}${thinking}`;

  // Colour carries kind, and the context percentage is the one number that can
  // mean "something must be done" — so it is the only thing allowed to be red
  // or yellow, and outside a warning it is plain muted like the counters.
  const contextStyle = percent === null || budget === null || budget <= 0
    ? null
    : percent > 90 ? styles.error : percent > 70 ? styles.warning : null;
  const statsTagged = groups.map((group) => {
    if (group === rateLabel) return styles.accent(group);
    if (group === contextLabel && contextStyle !== null) return contextStyle(group);
    return styles.muted(group);
  }).join(styles.muted(SEPARATOR));

  const row1 = composeRow(withSession, input.hint ?? '', width, styles);
  const row2 = composeRow(statsPlain, modelPlain, width, styles, statsTagged);
  return [row1, row2];
}

/**
 * Place `right` against the right edge, truncating the right side first.
 *
 * Two columns of padding are kept whenever both sides fit, because a path that
 * runs straight into a token count reads as one string. When they do not fit,
 * the right side is dropped only if it cannot keep `MIN_RIGHT` columns: a
 * `dee...` model name identifies nothing, and a bare path is more useful.
 *
 * `leftTagged` lets the caller supply a coloured rendering of the left side
 * that must not itself be truncated — the stats row, whose numbers are short
 * and always fit once the model name has been dropped.
 */
const MIN_RIGHT = 8;
function composeRow(
  leftPlain: string,
  rightPlain: string,
  width: number,
  styles: Styles,
  leftTagged?: string,
): string {
  const leftWidth = visibleWidth(leftPlain);
  const rightWidth = visibleWidth(rightPlain);

  if (rightPlain === '') {
    return leftTagged !== undefined && leftWidth <= width
      ? leftTagged
      : styles.muted(clipPlain(leftPlain, width));
  }

  const gap = width - leftWidth - rightWidth;
  if (gap >= 2) {
    return (leftTagged ?? styles.muted(leftPlain)) + ' '.repeat(gap) + styles.muted(rightPlain);
  }

  const availableForRight = width - leftWidth - 2;
  if (availableForRight >= MIN_RIGHT) {
    const clipped = clipPlain(rightPlain, availableForRight);
    const padding = Math.max(0, width - leftWidth - visibleWidth(clipped));
    return (leftTagged ?? styles.muted(leftPlain)) + ' '.repeat(padding) + styles.muted(clipped);
  }
  // Not enough room for the right side at all. The left side still has to fit:
  // a wrapped footer row lands below the screen and takes the input with it.
  return leftWidth <= width
    ? (leftTagged ?? styles.muted(leftPlain))
    : styles.muted(clipPlain(leftPlain, width));
}

/** Clip plain text to `maxWidth` visible columns, counting code points. */
function clipPlain(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  let width = 0;
  let out = '';
  for (const ch of Array.from(text)) {
    const next = visibleWidth(ch);
    if (width + next > maxWidth) break;
    out += ch;
    width += next;
  }
  return out;
}

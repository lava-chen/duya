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

import type { PermissionBadge } from './permission-mode.js';
import { taggedWith } from './theme.js';
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
  /**
   * The permission mode in force, as the badge the footer draws.
   *
   * Null when the caller does not track one: a footer that showed a mode it
   * could not keep true would be worse than no footer.
   */
  readonly permission?: PermissionBadge | null;
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

  const row1 = composeRow(withSession, [
    { plain: input.hint ?? '', tagged: (text) => styles.muted(text) },
  ], width, styles);
  const row2 = composeRow(statsPlain, rightSegments(input, styles, modelPlain), width, styles, statsTagged);
  return [row1, row2];
}

/**
 * The right-hand group of the stats row: the permission badge, the key that
 * cycles it, and the model paying for the turn.
 *
 * The badge is a hint about the session and the model name is its identity, so
 * the badge's HINT is the first thing to go when the row runs out of room and
 * the badge itself is the second. The model name is never dropped: a row that
 * says which model is running and nothing else still identifies the run.
 */
function rightSegments(
  input: FooterInput,
  styles: Styles,
  modelPlain: string,
): RowSegment[] {
  const segments: RowSegment[] = [];
  const badge = input.permission ?? null;
  if (badge !== null) {
    segments.push({
      plain: badge.plain,
      tagged: (text) => taggedWith(styles.tags, badge.token, text),
      separator: '',
    });
    if (badge.hint !== '') {
      segments.push({
        plain: badge.hint,
        tagged: (text) => styles.muted(text),
        separator: ' ',
        optional: true,
      });
    }
  }
  segments.push({
    plain: modelPlain,
    tagged: (text) => styles.muted(text),
    separator: '  ',
  });
  return segments;
}

/**
 * One piece of a row's right-hand group.
 *
 * `optional` marks the piece that may be dropped when the row runs out of
 * room. `separator` is the text that precedes this piece; the first piece of
 * a group carries none, because the group as a whole is what sits against the
 * right edge.
 */
interface RowSegment {
  /** The text as the terminal measures it. */
  readonly plain: string;
  /**
   * The coloured rendering of a piece.
   *
   * A function, not a string, because the piece may be CLIPPED and the
   * colour has to survive the clip: a truncated model name is still a model
   * name, and it is still muted.
   */
  readonly tagged: (plain: string) => string;
  /** May be dropped when the row is too narrow for everything. */
  readonly optional?: boolean;
  /** The text before this piece. Defaults to two spaces. */
  readonly separator?: string;
}

/** The space between two pieces of a right-hand group. */
const SEGMENT_GAP = '  ';

/**
 * Place the right-hand group against the right edge, truncating it first.
 *
 * Two columns of padding are kept whenever both sides fit, because a path that
 * runs straight into a token count reads as one string. When they do not fit,
 * the group gives way in a fixed order, and the order is the order of what
 * each piece is worth:
 *
 *   1. the TAIL is clipped — the last piece identifies the least, and a
 *      truncated model name still names the model;
 *   2. the OPTIONAL piece goes — the hint that repeats a key the badge
 *      already implies is the first thing a narrow row can lose;
 *   3. the tail goes entirely — a model name that cannot keep `MIN_RIGHT`
 *      columns identifies nothing;
 *   4. the badge goes last, because a row that does not say which permission
 *      mode is in force is the one failure this whole feature exists to
 *      prevent.
 *
 * `leftTagged` lets the caller supply a coloured rendering of the left side
 * that must not itself be truncated — the stats row, whose numbers are short
 * and always fit once the model name has been dropped.
 */
const MIN_RIGHT = 8;
function composeRow(
  leftPlain: string,
  right: readonly RowSegment[],
  width: number,
  styles: Styles,
  leftTagged?: string,
): string {
  const leftWidth = visibleWidth(leftPlain);
  const left = (): string => (leftTagged !== undefined && leftWidth <= width
    ? leftTagged
    : styles.muted(clipPlain(leftPlain, width)));

  const segments = normalizeSegments(right);
  if (segments.length === 0) return left();

  const available = width - leftWidth;
  const head = segments.slice(0, -1);
  const tail = segments[segments.length - 1];
  const mandatoryHead = head.filter((segment) => segment.optional !== true);
  // The order the group gives way in. Each entry is a group that is still
  // worth drawing; the first one that fits wins.
  const candidates: ReadonlyArray<readonly [readonly RowSegment[], RowSegment | null]> = [
    [head, tail],
    [mandatoryHead, tail],
    [head, null],
    [mandatoryHead, null],
    [[], tail],
  ];
  for (const [candidateHead, candidateTail] of candidates) {
    const fit = fitGroup(candidateHead, candidateTail, available);
    if (fit !== null) return left() + ' '.repeat(fit.padding) + fit.text;
  }
  // Not enough room for the right side at all. The left side still has to fit:
  // a wrapped footer row lands below the screen and takes the input with it.
  return leftWidth <= width ? left() : styles.muted(clipPlain(leftPlain, width));
}

/**
 * Fit a head and a tail into the columns that are left.
 *
 * The tail is clipped rather than dropped when it can keep `MIN_RIGHT`
 * columns; null means this shape does not fit at all.
 */
function fitGroup(
  head: readonly RowSegment[],
  tail: RowSegment | null,
  available: number,
): { readonly text: string; readonly padding: number } | null {
  const headWidth = measureSegments(head);
  const separator = tail !== null && head.length > 0 ? (tail.separator ?? SEGMENT_GAP) : '';
  const tailWidth = tail === null ? 0 : visibleWidth(tail.plain);
  const total = headWidth + visibleWidth(separator) + tailWidth;

  if (total <= available - 2) {
    return {
      text: renderSegments(head) + (tail === null ? '' : separator + tail.tagged(tail.plain)),
      padding: Math.max(0, available - total),
    };
  }
  if (tail === null) return null;
  const room = available - 2 - headWidth - visibleWidth(separator);
  if (room < MIN_RIGHT) return null;
  const clipped = clipPlain(tail.plain, room);
  const used = headWidth + visibleWidth(separator) + visibleWidth(clipped);
  return {
    text: renderSegments(head) + separator + tail.tagged(clipped),
    padding: Math.max(0, available - used),
  };
}

/**
 * Drop the empty pieces and un-indent the first one.
 *
 * The first piece of a group sits against the right edge, so it carries no
 * separator — otherwise a group of one would be indented by the gap that
 * separates two.
 */
function normalizeSegments(segments: readonly RowSegment[]): RowSegment[] {
  const kept = segments.filter((segment) => segment.plain !== '');
  const first = kept[0];
  if (first === undefined) return [];
  return [{ ...first, separator: '' }, ...kept.slice(1)];
}

/** The columns a group of pieces occupies. */
function measureSegments(segments: readonly RowSegment[]): number {
  let width = 0;
  for (const segment of segments) {
    width += visibleWidth(segment.separator ?? SEGMENT_GAP);
    width += visibleWidth(segment.plain);
  }
  return width;
}

/** The coloured rendering of a group. */
function renderSegments(segments: readonly RowSegment[]): string {
  return segments
    .map((segment) => `${segment.separator ?? SEGMENT_GAP}${segment.tagged(segment.plain)}`)
    .join('');
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

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

import {
  CAPACITY_EMPTY,
  CAPACITY_FILLED,
  capacityBarCellsForWidth,
  capacityFilledCells,
} from './capacity-bar.js';
import type { PermissionBadge } from './permission-mode.js';
import type { StatuslineProfile } from './preferences.js';
import { encodeHyperlinkTag } from './core/span.js';
import { prFooterLabel, prTone, type PrBadge } from './pr-badge.js';
import { taggedWith } from './theme.js';
import type { Styles } from './transcript-view.js';
import { codePointWidth, truncateToWidth, visibleWidth } from './width.js';

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
  /**
   * The pull request this session is working on, as the Host last observed it.
   *
   * Null when the Host knows of none: the badge is optional, and a footer that
   * showed a pull request the Host has not observed would be a claim.
   */
  readonly pullRequest?: PrBadge | null;
  /**
   * Whether the terminal can carry OSC 8 hyperlinks.
   *
   * A literal `]8;;url` in the footer is worse than a plain label, so the link
   * is only emitted when the terminal is known to understand it.
   */
  readonly hyperlinks?: boolean;
  readonly statusline?: StatuslineProfile;
  /**
   * The running token totals (`↑in ↓out Σtotal`), under the profile's verdict.
   *
   * `undefined` keeps the profile in charge, which is what every non-TUI
   * caller wants. `false` removes them even on a profile that shows them:
   * the three totals are the session's accumulated bill, and the row's other
   * two groups — how full the window is, how fast it answered — are the ones
   * about right now. `/settings` owns the switch.
   *
   * It cannot turn them ON where the profile dropped them: a profile is a
   * preset the reader chose for the whole row, and one switch silently undoing
   * half of it would make the preset a lie.
   */
  readonly counters?: boolean;
  /** The output rate of the last billed call, under the profile's verdict. */
  readonly rate?: boolean;
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

/** Keep the path recognizable while reserving room for branch and PR state. */
export function fitFooterLocation(path: string, suffix: string, width: number): string {
  const available = Math.max(0, Math.floor(width));
  if (visibleWidth(path + suffix) <= available) return path + suffix;
  if (visibleWidth(suffix) >= available) return truncateToWidth(suffix, available);
  return middleClip(path, available - visibleWidth(suffix)) + suffix;
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

  const profile = input.statusline ?? 'full';
  const showLocation = profile === 'full' || profile === 'compact' || profile === 'location';
  const showBranch = profile === 'full' || profile === 'location';
  const showSession = profile === 'full' || profile === 'location';
  const showUsage = (profile === 'full' || profile === 'compact' || profile === 'usage')
    && input.counters !== false;
  const showContext = profile !== 'location';
  const showRate = (profile === 'full' || profile === 'usage') && input.rate !== false;
  const showModel = profile !== 'location' || profile === 'location';
  const location = showLocation ? formatCwdForFooter(input.cwd, input.home) : '';
  const branch = showBranch ? input.branch ?? null : null;
  const branchText = branch === null || branch === '' ? '' : ` (${branch})`;
  // The pull request belongs to "where": it says what the work in this
  // session is FOR. The narrow profiles leave it out — they are the ones the
  // reader chose to have less on screen.
  const showPullRequest = profile === 'full' || profile === 'location';
  const badge = showPullRequest ? input.pullRequest ?? null : null;
  const sessionName = !showSession || input.sessionName === undefined || input.sessionName === null ? '' : input.sessionName;
  // The badge sits between the path and the session name. Long paths give up
  // their middle first so the branch and PR state stay visible; the session
  // name is dropped before either when the terminal is too narrow.
  const badgeLabel = badge === null ? '' : prFooterLabel(badge);
  let visibleBadgeLabel = badgeLabel;
  let badgeSuffix = badge === null ? '' : ` · ${visibleBadgeLabel}`;
  if (visibleWidth(badgeSuffix) > width) {
    visibleBadgeLabel = width <= 3 ? '' : truncateToWidth(badgeLabel, width - 3);
    badgeSuffix = visibleBadgeLabel === '' ? '' : ` · ${visibleBadgeLabel}`;
  }
  const sessionSuffix = sessionName === '' ? '' : ` · ${sessionName}`;
  let visibleBranch = branchText;
  let visibleSession = sessionSuffix;
  if (visibleWidth(visibleBranch + badgeSuffix + visibleSession) > width) visibleSession = '';
  if (visibleWidth(visibleBranch + badgeSuffix) > width && badgeSuffix !== '') {
    visibleBranch = truncateToWidth(visibleBranch, Math.max(0, width - visibleWidth(badgeSuffix)));
  }
  const visibleSuffix = visibleBranch + badgeSuffix + visibleSession;
  const visibleLocation = fitFooterLocation(location, visibleSuffix, width);
  const visiblePath = visibleLocation.slice(0, visibleLocation.length - visibleSuffix.length);
  const row1Plain = visibleLocation;
  const stats = input.stats;
  const counters: string[] = [];
  if (showUsage && stats.inputTokens > 0) counters.push(`↑${formatTokenCount(stats.inputTokens)}`);
  if (showUsage && stats.outputTokens > 0) counters.push(`↓${formatTokenCount(stats.outputTokens)}`);
  if (showUsage && stats.totalTokens > 0) counters.push(`Σ${formatTokenCount(stats.totalTokens)}`);

  const budget = stats.contextBudget ?? null;
  const percent = stats.contextPercent;
  // The context group is a SHAPE and a number, not a fraction. `42%/200k` was
  // two numbers of two different kinds glued together by a slash, and the
  // reader had to do the division themselves to see how close to full the
  // window was — which is the entire question this row exists to answer. The
  // bar answers it at a glance; the percentage says it exactly; the window size
  // was never a reading, only a denominator, and `/context` still reports it.
  const hasBudget = showContext && budget !== null && budget > 0;
  const barCells = hasBudget ? capacityBarCellsForWidth(width) : 0;
  const ratio = percent === null ? null : percent / 100;
  // `?` before the first billed call, like pi: the window size is known, the
  // usage is not, and a confident "0%" would be a claim rather than a reading.
  // The bar is drawn hollow in that case rather than omitted, so the row does
  // not change shape the moment the first call lands.
  const context = hasBudget ? contextGroup(styles, barCells, ratio, percent) : null;
  // The output rate of the MOST RECENT billed call, measured against the
  // provider's own request duration. It is omitted entirely when the provider
  // reported no duration, rather than shown as a zero.
  const rate = stats.outputTokensPerSecond;
  const rateLabel = showRate && rate !== null && Number.isFinite(rate) ? formatTokensPerSecond(rate) : '';

  // Three GROUPS, not a run of bare tokens. The counters answer "what has this
  // session spent", the bar "how much of the window is left", the rate "how
  // fast did the last answer come". Single spaces made five numbers of three
  // different kinds read as one undifferentiated run, which is the shape this
  // row was criticised for; the separator and one colour per kind are what tell
  // them apart without adding a row or a label.
  const statsGroups: Array<{ readonly plain: string; readonly tagged: string }> = [];
  const countersText = counters.join(' ');
  if (countersText !== '') statsGroups.push({ plain: countersText, tagged: styles.muted(countersText) });
  if (context !== null) statsGroups.push(context);
  if (rateLabel !== '') statsGroups.push({ plain: rateLabel, tagged: styles.accent(rateLabel) });
  const statsPlain = statsGroups.map((group) => group.plain).join(SEPARATOR);
  const statsTagged = statsGroups.map((group) => group.tagged).join(styles.muted(SEPARATOR));

  const model = showModel ? input.model ?? null : null;
  const provider = model?.provider === undefined || model.provider === '' ? '' : `(${model.provider}) `;
  const thinking = model?.thinking === undefined || model.thinking === '' ? '' : ` • ${model.thinking}`;
  const modelPlain = model === null ? '' : `${provider}${model.model}${thinking}`;

  // The badge's state is explicit text with a reinforcing colour, not a glyph:
  // the footer is fixed-width and a symbol's cell width is ambiguous in CJK terminals.
  const paintPrBadge = (target: PrBadge, label: string): string => {
    const tone = prTone(target.state);
    const painted = tone === 'success' ? styles.success(label)
      : tone === 'error' ? styles.error(label)
      : tone === 'warning' ? styles.warning(label)
      : tone === 'muted' ? styles.muted(label)
      : styles.accent(label);
    if (input.hyperlinks !== true || target.url === null) return painted;
    const tag = encodeHyperlinkTag(target.url);
    return tag === null ? painted : `{${tag}}${painted}{/${tag}}`;
  };
  // Without a badge the row is one muted run, exactly as it was before the
  // badge existed; with one, only the badge carries its own colour.
  const row1Tagged = badge === null || badgeSuffix === ''
    ? styles.muted(visibleLocation)
    : styles.muted(`${visiblePath}${visibleBranch} · `)
      + paintPrBadge(badge, visibleBadgeLabel)
      + (visibleSession === '' ? '' : styles.muted(visibleSession));
  const row1 = composeRow(row1Plain, [
    { plain: profile === 'full' || profile === 'compact' ? input.hint ?? '' : '', tagged: (text) => styles.muted(text) },
  ], width, styles, row1Tagged);
  const row2 = composeRow(statsPlain, rightSegments(input, styles, modelPlain), width, styles, statsTagged);
  return [row1, row2];
}

/**
 * The context group: a bar, then the percentage, in the tone the percentage
 * earned.
 *
 * Returns plain and tagged together rather than letting the caller tag the
 * plain string afterwards, because the group is the one place on the row where
 * TWO tones share a segment — a bar painted in a single colour cannot say
 * "nearly full" without also painting its empty part in the alarm colour, and
 * the empty part is precisely what the reader is being warned about running
 * out of.
 *
 * `cells === 0` is the narrow-terminal case: the percentage alone still says
 * what the bar would have said, so the group degrades to a number instead of
 * disappearing.
 */
function contextGroup(
  styles: Styles,
  cells: number,
  ratio: number | null,
  percent: number | null,
): { readonly plain: string; readonly tagged: string } {
  const filled = capacityFilledCells(ratio, cells);
  const empty = Math.max(0, cells - filled);
  // Colour carries absence of room here and nowhere else on this row, because
  // the context percentage is the one number that can mean "something must be
  // done". Below the warning threshold it is plain muted, like the counters.
  const tone = percent === null
    ? styles.muted
    : percent > 90 ? styles.error : percent > 70 ? styles.warning : styles.muted;
  const label = percent === null ? '?' : `${Math.round(percent)}%`;
  const plainBar = CAPACITY_FILLED.repeat(filled) + CAPACITY_EMPTY.repeat(empty);
  const taggedBar = (filled === 0 ? '' : tone(CAPACITY_FILLED.repeat(filled)))
    + (empty === 0 ? '' : styles.muted(CAPACITY_EMPTY.repeat(empty)));
  return cells === 0
    ? { plain: label, tagged: tone(label) }
    : { plain: `${plainBar} ${label}`, tagged: `${taggedBar} ${tone(label)}` };
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

/** Keep both ends of a long path and the suffix callers reserved beside it. */
function middleClip(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  const budget = maxWidth - 1;
  let left = '';
  let leftWidth = 0;
  const points = Array.from(text);
  let leftIndex = 0;
  const leftBudget = Math.ceil(budget / 2);
  while (leftIndex < points.length) {
    const point = points[leftIndex]!;
    const pointWidth = codePointWidth(point);
    if (leftWidth + pointWidth > leftBudget) break;
    left += point;
    leftWidth += pointWidth;
    leftIndex += 1;
  }
  let right = '';
  let rightWidth = 0;
  for (let index = points.length - 1; index >= leftIndex; index -= 1) {
    const point = points[index]!;
    const pointWidth = codePointWidth(point);
    if (leftWidth + rightWidth + pointWidth > budget) break;
    right = point + right;
    rightWidth += pointWidth;
  }
  return `${left}…${right}`;
}

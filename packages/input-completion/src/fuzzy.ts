/**
 * Fuzzy subsequence matching with a score.
 *
 * ## Why this exists at all
 *
 * The desktop filters its popover by plain substring
 * (`message-input-logic.ts:95`), which is right for `/doc` finding `/doctor`
 * and terrible for paths: a user typing `@src/uA` cannot find
 * `src/app/useApp.ts` because no contiguous substring of it is `src/uA`.
 *
 * Both reference implementations solved this the same way, independently:
 *
 *  - **codex** — `codex-rs/utils/fuzzy-match/src/lib.rs`: a cursor scans
 *    forward through the lowercased haystack and `lowered_chars[cur] == nc` is
 *    the only accept test; the cursor NEVER resets, so out-of-order characters
 *    cannot match. Scoring is a window width, minus 100 when the first hit is
 *    at index 0.
 *  - **minimax-code** — `packages/tui/src/tui/engine/fuzzy.ts`: the same
 *    in-order scan, plus consecutive-match bonus, gap penalty and a
 *    word-boundary bonus.
 *
 * The cursor rule is the part worth stating out loud, because it is what makes
 * the result rankable rather than merely boolean: `@uapp` matches
 * `useApp` and `@pau` does not match it, and neither of those is obvious from
 * the name of the function.
 *
 * ## Score convention
 *
 * **Lower is better**, and negative is good. This is minimax-code's convention
 * (`fuzzy.ts:135` sorts ascending on `totalScore`) rather than codex's, because
 * the richer term set reads correctly against it: a prefix hit scores well
 * negative and a scattered hit lands near zero.
 */

/** Word separators that make the following character a good place to match. */
const BOUNDARY_CHARS = new Set([' ', '\t', '-', '_', '.', '/', ':', '\\']);

/** Bonus for each character matched immediately after the previous one. */
const CONSECUTIVE_BONUS = -5;
/** Penalty per character skipped between two matched characters. */
const GAP_PENALTY = 2;
/** Bonus for matching the first character of a segment. */
const BOUNDARY_BONUS = -10;
/** Bonus for matching the very first character of the haystack. */
const START_BONUS = -10;
/** Bonus for an exact whole-string match. */
const EXACT_BONUS = -100;

/**
 * How many occurrences of the first needle character are tried as a start.
 *
 * The scan is O(needle x haystack) per start, so this is the bound that keeps
 * typing latency flat. 24 is far above the number of plausible starts for a
 * real path and far below the point where a pathological haystack hurts.
 */
const MAX_STARTS = 24;

/** One code point of the haystack, with its UTF-16 offset. */
interface Unit {
  ch: string;
  at: number;
}

export interface FuzzyMatchResult {
  /**
   * Indices into the HAYSTACK (not the needle) that matched, ascending, in
   * UTF-16 offsets so a caller can slice or highlight with them directly.
   *
   * A renderer needs these to show which characters caused the hit, which is
   * most of the point of ranking rather than filtering.
   */
  indices: number[];
  /** Lower is better. Negative is good. */
  score: number;
}

/**
 * Split the haystack into code points, keeping each one's UTF-16 offset.
 *
 * Code points, not UTF-16 units: comparing one unit against a whole code point
 * matches CJK fine (they are BMP) and returns `null` for everything outside the
 * BMP — so a label containing an emoji could never be completed at all. The
 * TUI transcript renders emoji, so they do appear in labels.
 */
function toUnits(haystack: string): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < haystack.length; ) {
    const cp = haystack.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    units.push({ ch: ch.toLowerCase(), at: i });
    i += ch.length;
  }
  return units;
}

/**
 * Greedy alignment of the whole needle starting at `from`.
 *
 * Greedy within a start is what produces the consecutive-run bonuses: taking
 * the earliest continuation of each character is what lets a run score as a
 * run. Returns `null` when the needle cannot be completed from here.
 */
function alignFrom(units: readonly Unit[], needle: readonly string[], from: number): FuzzyMatchResult | null {
  const indices: number[] = [];
  let score = 0;
  let cursor = from;
  let previous = -1;

  for (let n = 0; n < needle.length; n += 1) {
    const ch = needle[n] as string;

    let found = -1;
    for (let i = cursor; i < units.length; i += 1) {
      if (units[i]?.ch === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;

    if (previous !== -1) {
      if (found === previous + 1) {
        score += CONSECUTIVE_BONUS;
      } else {
        score += GAP_PENALTY * (found - previous - 1);
      }
    } else {
      const unit = units[found];
      if (unit && unit.at === 0) {
        score += START_BONUS;
      } else if (found > 0) {
        // The boundary test reads the PREVIOUS unit rather than slicing the
        // raw string backwards. Slicing `unit.at - 1` gives a low surrogate
        // when the preceding character is astral, which would read as "no
        // boundary" for a path segment that actually started one.
        if (BOUNDARY_CHARS.has(units[found - 1]?.ch ?? '')) score += BOUNDARY_BONUS;
      }
    }

    indices.push(units[found]?.at ?? 0);
    previous = found;
    cursor = found + 1;
  }

  return { indices, score };
}

/**
 * Match `needle` against `haystack` as an in-order subsequence, best alignment
 * first.
 *
 * Returns `null` when the needle cannot be matched in order. That is the only
 * failure mode — there is no "matched but scored badly" outcome, because a
 * caller that does not rank would still have to show the row.
 *
 * An empty needle matches with score 0 and no indices, so an empty filter is a
 * no-op rather than a special case at every call site.
 *
 * ## Why it is not a single-pass greedy scan
 *
 * A single left-to-right scan commits to the FIRST occurrence of the first
 * character and never revisits it, so `now` against `run 👋 now` aligns to the
 * `n` inside `run`, crosses a gap, and scores worse than the contiguous `now` at
 * the end — while never being able to see it. Both reference implementations
 * avoid this differently: codex re-measures a window around the first hit,
 * minimax-code scores several candidate alignments. This takes the cheaper of
 * the two routes — re-run the greedy scan from each occurrence of the first
 * character, up to `MAX_STARTS`, and keep the best score.
 */
export function fuzzyMatch(haystack: string, needle: string): FuzzyMatchResult | null {
  if (needle === '') return { indices: [], score: 0 };

  const units = toUnits(haystack);
  const chars = [...needle].map((c) => c.toLowerCase());
  const first = chars[0];
  if (first === undefined) return { indices: [], score: 0 };

  // Exact match wins outright, so the multi-start search cannot bury it.
  if (haystack.toLowerCase() === needle.toLowerCase()) {
    return { indices: units.map((unit) => unit.at), score: EXACT_BONUS };
  }

  let best: FuzzyMatchResult | null = null;
  let starts = 0;
  for (let i = 0; i < units.length && starts < MAX_STARTS; i += 1) {
    if (units[i]?.ch !== first) continue;
    starts += 1;
    const attempt = alignFrom(units, chars, i);
    if (attempt === null) continue;
    if (best === null || attempt.score < best.score) best = attempt;
  }

  return best;
}

/**
 * Rank `items` by how well their text matches `query`, best first.
 *
 * Non-matching items are dropped. Items that do not match are not reordered
 * relative to each other, so a caller wanting a secondary sort applies it
 * after.
 *
 * `getText` defaults to a plain string input; the generic form exists so a
 * caller can rank `PopoverItem`s by `label` without building an intermediate
 * array.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string = (item: T) => String(item),
): T[] {
  const scored: Array<{ item: T; score: number; order: number }> = [];

  items.forEach((item, order) => {
    const match = fuzzyMatch(getText(item), query);
    if (match === null) return;
    scored.push({ item, score: match.score, order });
  });

  // `order` as the tiebreaker makes the sort STABLE, which the platform sort is
  // not guaranteed to be. Without it, equal-scoring rows could reshuffle between
  // renders and the selection would appear to move on its own.
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.order - b.order));

  return scored.map((entry) => entry.item);
}
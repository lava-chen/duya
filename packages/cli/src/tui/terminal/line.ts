/**
 * The one place that knows both spellings of a line.
 *
 * ## Why a conversion module instead of two parallel APIs
 *
 * A line reaches the rendering seam either as a blessed-tagged string (every
 * renderer written before plan 615) or as spans (the target). Adding a second
 * field to every patch and every frame would double the surface, and every
 * consumer would have to say "prefer spans, else tags" — five copies of the same
 * branch, each free to forget the tag case.
 *
 * Instead one type says "either", and this module converts. Consumers ask for
 * the shape THEY need:
 *
 * - blessed needs tags (`lineToTags`) — it parses them, so it is the last leg
 *   that still speaks that vocabulary.
 * - the inline writer needs ANSI (`lineToAnsi`).
 * - the own screen painter needs spans (`lineToSpans`), and converts a tagged
 *   line exactly once rather than re-parsing escapes inside its paint loop.
 *
 * ## Round-tripping a tagged line is not byte-identical, and that is fine
 *
 * `lineToSpans('{gray-fg}x{/gray-fg}')` then `spansToTags` gives the same bytes,
 * but a line with redundant tags (`{bold}a{/bold}{bold}b{/bold}`) comes back
 * minimised (`{bold}ab{/bold}`). The screen is identical — that is what
 * `spansToTags` promises — and nothing downstream compares tag strings. What
 * must NOT drift is the painted result, which the parity tests compare cell by
 * cell.
 */

import { tagsToSpans } from '../core/tags.js';
import type { SceneLine, StyledSpan } from '../core/span.js';
import { spansToAnsi } from './ansi.js';
import { spansToTags, type SpanTagView } from '../markdown/inline.js';

/** The spans a line describes, converting from tags when necessary. */
export function lineToSpans(line: SceneLine): readonly StyledSpan[] {
  return typeof line === 'string' ? tagsToSpans(line) : line;
}

/**
 * The ANSI sequence for a line, ready to write to the terminal.
 *
 * A tagged line is parsed to spans first and then serialised. That is one extra
 * pass for legacy callers, and it is the point of the phase: the inline path had
 * two tag→ANSI implementations (`terminal/sgr.ts` for the rows it wrote, and
 * another inside `terminal/diff.ts` for the rows it compared), and two
 * implementations of "what does this tag mean" is how a row comes out one colour
 * when compared and another when written.
 *
 * Now `spansToAnsi` is the only writer for this path, and a tagged line and its
 * span spelling produce the same bytes — which is what lets a renderer migrate
 * to spans without changing the scrollback it commits.
 */
export function lineToAnsi(line: SceneLine): string {
  return spansToAnsi(lineToSpans(line));
}

/** The blessed tag spelling, for the one renderer that parses tags. */
export function lineToTags(line: SceneLine, view: SpanTagView = DEFAULT_TAG_VIEW): string {
  return typeof line === 'string' ? line : spansToTags(line, view);
}

/**
 * How a span degrades when blessed is the target.
 *
 * Only the two folds need a colour: blessed cannot paint italic or strike, so
 * they become the theme's accent and muted. These are the dark palette's values,
 * which is also what every existing markup assertion pins. A caller that cares
 * about the light palette passes its own view — no surface plumbs a theme today,
 * and inventing a parameter for it before anything needs one would be the same
 * mistake as the unused cache slot avoided elsewhere.
 */
const DEFAULT_TAG_VIEW: SpanTagView = {
  renderer: 'blessed',
  accent: { kind: 'named', name: 'cyan' },
  muted: { kind: 'named', name: 'gray' },
};

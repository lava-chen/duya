/**
 * Streaming commit boundary: which source is safe to render as Markdown while
 * a text block is still arriving.
 *
 * ## The problem
 *
 * An assistant block is re-rendered from scratch on every delta — the cache key
 * includes the block's text (`transcript-cache.ts`, `blockContent` returns
 * `a:${finalized}:${text}`), so changed text is a guaranteed miss. Correct and
 * cheap for FINISHED blocks, but it means a half-written Markdown construct is
 * interpreted as if it were complete, and the transcript moves while the answer
 * is still typing.
 *
 * Two shapes of damage, and they are not equally bad:
 *
 * - **Geometric reflow** — the line's rendered extent or its position moves.
 *   This is the one worth preventing.
 * - **Style flip** — the line stays put and only its styling settles (a
 *   half-typed `**bo` reads literally, then becomes bold). codex has exactly
 *   this in its tail region, and it reads as typing rather than corruption.
 *
 * ## Only tables are held back today
 *
 * A pipe table is the only construct that is non-incremental by construction:
 * `renderTable` sizes every column to the max over ALL rows
 * (`transcript-view.ts`), so one wider arriving row moves EVERY column border,
 * and until the delimiter row arrives the header is not a table at all but a
 * paragraph. There is no intermediate rendering that is both correct and
 * stable, so the whole table is withheld until something proves it stopped
 * growing.
 *
 * ## What is deliberately NOT held back, and why
 *
 * An unclosed code fence. The tempting argument is that an opening fence with
 * no closer swallows the following prose into the code block, and that prose
 * jumps back out when the fence closes. That does not happen while streaming:
 * while the fence is open, everything after the opener IS the code still
 * arriving, and the prose that follows only appears after the fence closes —
 * so there is no reclassification to prevent. Withholding it would cost the
 * reader the content they are watching, which `tui-transcript-markup.test.ts`
 * pins directly ("keeps an unfinished streaming fence readable and closes only
 * its display frame" — content inside the frame, `└─` marking it open).
 *
 * The same argument covers the in-flight trailing line: showing it is what makes
 * a stream feel live, and holding it back buys nothing against a style flip.
 *
 * ## What this is NOT
 *
 * codex's `commit_complete_source()` protects a STABLE region — history already
 * written to the terminal's own scrollback, which is irreversible, so a partial
 * line can never become settled. duya has no such region: it is alt-screen,
 * every frame re-renders the whole viewport, and nothing is ever frozen (the
 * same reason `transcript-cache.ts` exists rather than being redundant). There
 * is no irreversible act to protect, so "commit" here means the narrower thing:
 * **do not interpret a construct that is still being written.**
 */

/** The opening or closing fence marker of a line, or null. */
function fenceOf(line: string): { marker: string; length: number; closing: boolean } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return null;
  const delimiter = match[1] ?? '';
  return {
    marker: delimiter[0] ?? '`',
    length: delimiter.length,
    closing: (match[2] ?? '').trim() === '',
  };
}

/**
 * A pipe row is a table header only when the NEXT line is a delimiter row.
 * A sentence containing `|` must keep rendering as prose.
 *
 * Mirrors `isTableDelimiter` in `transcript-view.ts` deliberately: these two
 * must agree, or a block renders differently depending on whether it happens
 * to be finished.
 */
function isTableDelimiter(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|\s*$/u, '')
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.replace(/\\\|/gu, '|').trim());
  return cells.length >= 1 && cells.every((cell) => /^:?-{1,}:?$/u.test(cell));
}

/** Whether an unclosed fence is open at the end of `lines`. Exported for tests. */
export function hasOpenFence(lines: readonly string[]): boolean {
  let open: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const fence = fenceOf(line);
    if (fence === null) continue;
    if (open === null) {
      open = { marker: fence.marker, length: fence.length };
      continue;
    }
    // A closing fence must use the same character and be at least as long as
    // the opener. This is the same rule `renderAssistantMarkdown` applies.
    if (fence.closing && fence.marker === open.marker && fence.length >= open.length) open = null;
  }
  return open !== null;
}

/**
 * The index of a still-growing table's first line, or null when there is none.
 *
 * A table counts as still growing when it runs to the end of what has arrived:
 * nothing after it has proved it stopped. A line after it — even a blank one —
 * is the proof.
 */
export function growingTableStart(lines: readonly string[]): number | null {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes('|')) continue;
    if (!isTableDelimiter(lines[index + 1] ?? '')) continue;

    let end = index + 2;
    while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim() !== '') {
      end += 1;
    }
    if (end === lines.length) return index;
    index = end - 1;
  }
  return null;
}

export interface StreamCommit {
  /** Source prefix that is safe to render through the Markdown renderer. */
  readonly safe: string;
  /** The withheld source, to be released once the construct closes. */
  readonly inFlight: string;
  /** True when a growing table is being withheld. */
  readonly holding: boolean;
}

/**
 * Split accumulated text into a safely-renderable prefix and a withheld tail.
 *
 * Call this ONLY for a block whose `finalized` is false. A finalized block is
 * complete by definition and must render in full — withholding a finished table
 * would be worse than the reflow it prevents.
 */
export function splitStreamCommit(text: string): StreamCommit {
  // Normalize ONCE and derive every offset from the normalized form. Computing
  // the break index on the raw text and slicing the normalized one is off by one
  // per preceding `\r\n`.
  const normalized = text.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');

  const hold = growingTableStart(lines);
  if (hold !== null) {
    // The prose above the hold point is what the reader is tracking, so it stays
    // committed; everything from the table's header onward is withheld.
    const safe = lines.slice(0, hold).join('\n');
    return {
      safe: safe === '' ? '' : `${safe}\n`,
      inFlight: lines.slice(hold).join('\n'),
      holding: true,
    };
  }

  return { safe: normalized, inFlight: '', holding: false };
}
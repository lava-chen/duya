/**
 * Summary quality guard: detects degenerate (empty / junk) summaries and
 * cleans the raw summary text before it is persisted into the compacted history.
 */

/**
 * Strip conversational noise and scratchpad artifacts from a raw summary.
 * Returns cleaned text; never throws.
 */
export function cleanSummaryText(raw: string): string {
  let text = raw.trim()

  // Remove <analysis> / <scratchpad> blocks that some models emit before the
  // actual summary.
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
  text = text.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, '')

  // Plan 523 P3: a bare unclosed <analysis>/<scratchpad> prefix means the
  // model's reasoning block was cut off by the output limit — drop it up to
  // where the numbered body begins (mirrors grok's unclosed-analysis branch).
  text = text.replace(/^(<analysis>|<scratchpad>)[\s\S]*?(?=\n?\n?\d+\.|\Z)/i, '')

  // Remove the <summary> wrapper tag itself, keeping the inner content. A
  // closing tag present means the body is enclosed; an unclosed opening tag
  // (output truncated) is stripped so it cannot leak into the persisted text.
  if (/<\/summary>/i.test(text)) {
    const wrapped = text.match(/<summary>([\s\S]*)<\/summary>/i)
    text = (wrapped && wrapped[1] ? wrapped[1] : text).trim()
    text = text.replace(/<\/?summary>/gi, '')
  } else {
    text = text.replace(/<summary>/gi, '')
  }

  // Plan 523 P3: neutralize any <summary>/<analysis> literal echoed back into
  // the body with zero-width spaces, so a successor assistant is not induced
  // to re-narrate control tokens instead of the actual work.
  text = text.replace(/<(\/?summary)>/gi, '<\u200b$1>')
  text = text.replace(/<(\/?analysis)>/gi, '<\u200b$1>')

  // Collapse excessive blank lines.
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/**
 * Minimum characters a summary must have to be considered non-degenerate.
 */
export const MIN_SUMMARY_CHARS = 500

/**
 * Plan 523 P2: tool-invocation tokens that leak into a summary (DSML and other
 * DeepSeek-family reserved tokens rendered as plain text) prove the model
 * tried to "continue working / call tools" instead of writing a summary.
 * Case-insensitive. A summary containing any of these is degenerate even when
 * it is long — the length check alone lets a tool-call blob pass.
 */
const TOOL_TOKEN_BLACKLIST: RegExp = /(dsml|<｜|<tool_call|<minimax:tool_call|tool▁calls▁begin|<\/｜)/i

/**
 * Plan 523 P2: section headings expected in the 9-part summarization prompt.
 * A real summary hits at least three of them; a fabricated / truncated one
 * that merely quotes the transcript back or drifts into continuation does not.
 * Threshold is deliberately conservative (>= 3 of 9) so variation is not
 * false-flagged, while still catching the F2 "one-line continuation" class.
 */
// Note: `g` is required so `.match()` returns *every* heading (String#match
// without `g` returns only the first), which is what the distinct-heading
// count below depends on.
const SECTION_HEADING: RegExp =
  /^\s*\d+\.\s+\**(Primary Request|Key Technical|Files|Errors|Problem Solving|All User|Pending Tasks|Current Work|Optional Next)/gim

/** Minimum distinct section headings a real summary must hit (>= 3 of 9). */
const SECTION_MIN_HITS = 3

/**
 * True when the summary is too short, contains leaked tool-invocation markers,
 * or lacks enough structured section headings to be usable as a continuation
 * summary. Only applied to *new* summarizer output — never to a
 * `previousSummary` seed, which may legitimately lack the section structure
 * after an UPDATE pass.
 */
export function isDegenerateSummary(text: string): boolean {
  const cleaned = cleanSummaryText(text)
  // Placeholder or pure noise.
  if (/^\[.*messages? (from earlier|truncated)].*$/i.test(cleaned)) return true

  // Signal 1 — leaked tool-invocation tokens (F1 DSML class).
  if (TOOL_TOKEN_BLACKLIST.test(cleaned)) return true

  // Signal 2 — structured section headings (F2 continuation-drift class).
  const sectionHits = cleaned.match(SECTION_HEADING)
  const headingCount = sectionHits ? new Set(sectionHits.map((h) => h.replace(/\s+/g, ' ').trim())).size : 0
  if (headingCount < SECTION_MIN_HITS) return true

  // Signal 3 — length (a structured but unreasonably short summary is still
  // not enough to continue from). Order matters: heading + token checks run
  // before the length gate so a long tool blob does not short-circuit past
  // the structural signals.
  if (cleaned.length < MIN_SUMMARY_CHARS) return true
  return false
}
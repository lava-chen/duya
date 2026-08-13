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

  // Remove the <summary> wrapper tags themselves, keeping the inner content.
  const wrapped = text.match(/<summary>([\s\S]*)<\/summary>/i)
  if (wrapped && wrapped[1]) {
    text = wrapped[1].trim()
  }

  // Collapse excessive blank lines.
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/**
 * Minimum characters a summary must have to be considered non-degenerate.
 */
export const MIN_SUMMARY_CHARS = 500

/**
 * True when the summary is too short or contains no meaningful content to be
 * usable as a continuation summary.
 */
export function isDegenerateSummary(text: string): boolean {
  const cleaned = cleanSummaryText(text)
  if (cleaned.length < MIN_SUMMARY_CHARS) return true
  // Placeholder or pure noise.
  if (/^\[.*messages? (from earlier|truncated)].*$/i.test(cleaned)) return true
  return false
}
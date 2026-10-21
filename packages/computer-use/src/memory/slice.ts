/**
 * slice.ts — per-app memory slice + token budget (plan 454 §5 Task A).
 *
 * Slicing policy:
 *   1. Case-insensitive substring match on the app name.
 *   2. Match any entry whose `app` field contains the slice app name,
 *      OR any entry whose note references the app name in the leading
 *      40 characters (e.g. "- VS Code: Cmd+K ...").
 *   3. Truncate by token budget using a simple character/4 heuristic
 *      (one token ≈ 4 chars). Phase 3 keeps the heuristic simple;
 *      real token counting belongs in the agent's prompt layer.
 *
 * Output: { entries, text, truncated }. `text` is ready to be embedded
 * in a sub-agent system prompt. `truncated` is true when the entries
 * were cut to fit the budget.
 */

import type { MemoryEntry } from './index.js';

export interface MemorySlice {
  app: string;
  /** Entries that matched the app (insertion order). */
  entries: MemoryEntry[];
  /** Token-budgeted text suitable for a system prompt. */
  text: string;
  /** True when entries were truncated to fit the budget. */
  truncated: boolean;
  /** Estimated token count of `text` (chars / 4). */
  tokenEstimate: number;
}

/** Default token budget. ~500 tokens is enough for 2-3 short notes. */
export const DEFAULT_SLICE_TOKEN_BUDGET = 500;

/** Heuristic: one token ≈ 4 characters. Conservative on English. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Case-insensitive substring match.
 */
function appMatches(entry: MemoryEntry, appLower: string): boolean {
  if (entry.app.toLowerCase().includes(appLower)) return true;
  // Allow notes that lead with the app (e.g. "- VS Code: ...").
  const head = entry.note.slice(0, 40).toLowerCase();
  return head.includes(appLower);
}

/**
 * Build a slice for a single app. Returns the matched entries and
 * a token-budgeted text view.
 *
 * When `tokenBudget` is undefined, `DEFAULT_SLICE_TOKEN_BUDGET` is
 * used. Pass Infinity to disable truncation (used internally for
 * tests + sub-agents that explicitly opt out).
 */
export function sliceForApp(
  entries: ReadonlyArray<MemoryEntry>,
  app: string,
  tokenBudget: number = DEFAULT_SLICE_TOKEN_BUDGET,
): MemorySlice {
  const appLower = app.toLowerCase().trim();
  const matched = entries.filter((e) => appMatches(e, appLower));

  // Format each entry as `- note  (ts)`.
  const formatted = matched.map((e) => {
    const tsSuffix = e.ts ? `  (${e.ts})` : '';
    return `- ${e.note}${tsSuffix}`;
  });
  const fullText =
    matched.length === 0
      ? `(no memory entries for "${app}")`
      : `# ${app}\n\n${formatted.join('\n')}\n`;

  const fullTokens = estimateTokens(fullText);
  if (fullTokens <= tokenBudget) {
    return {
      app,
      entries: [...matched],
      text: fullText,
      truncated: false,
      tokenEstimate: fullTokens,
    };
  }

  // Truncate: keep the most recent entries (insertion order) until
  // we fit the budget.
  const maxChars = Math.max(0, tokenBudget * CHARS_PER_TOKEN);
  const kept: MemoryEntry[] = [];
  let acc = `# ${app}\n\n`.length;
  for (let i = matched.length - 1; i >= 0; i--) {
    const e = matched[i]!;
    const tsSuffix = e.ts ? `  (${e.ts})` : '';
    const line = `- ${e.note}${tsSuffix}\n`;
    if (acc + line.length > maxChars) break;
    kept.unshift(e);
    acc += line.length;
  }
  const truncatedText =
    kept.length === 0
      ? `# ${app}\n\n(truncated: token budget exhausted)\n`
      : `# ${app}\n\n${kept
          .map((e) => {
            const tsSuffix = e.ts ? `  (${e.ts})` : '';
            return `- ${e.note}${tsSuffix}`;
          })
          .join('\n')}\n\n[... ${matched.length - kept.length} earlier entries truncated]\n`;

  return {
    app,
    entries: kept,
    text: truncatedText,
    truncated: true,
    tokenEstimate: estimateTokens(truncatedText),
  };
}
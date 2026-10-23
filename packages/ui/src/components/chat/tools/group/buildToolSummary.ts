// Round-level tool summary — the one-line headline of a finished round.
//
// The reference transcripts (Codex, Claude Code) put the category verb
// phrases and the aggregated diff stat on the SAME line:
//
//   Edited 5 files, created a file, read 2 files, ran 3 commands +23 -14
//
// `buildGroupSummary` already produces the verb phrases; this module
// adds the round-level diff stat on top of it, summed from the very
// same per-row numbers the expanded rows show.

import type { TranslationKey } from '@/i18n';
import { aggregateFileEditStats } from '../fileEditStats';
import type { ToolAction } from '../types';
import { buildGroupSummary } from './buildGroupSummary';

export interface ToolSummary {
  /** Category verb phrases, e.g. "Edited 2 files, ran 13 commands". */
  text: string;
  additions: number;
  removals: number;
  /** True when there is at least one line added or removed. */
  hasDiff: boolean;
}

// A round usually mixes more categories than a single group does
// (create + read + edit + commands is the common shape in the
// reference transcripts), so the round line keeps more parts before it
// folds the tail into "+N more".
const ROUND_MAX_PARTS = 5;

/**
 * Build the summary line for a set of tool calls.
 *
 * Pure function — no React, no side effects.
 */
export function buildToolSummary(
  tools: ToolAction[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: string,
  maxParts: number = ROUND_MAX_PARTS,
): ToolSummary {
  const text = buildGroupSummary(tools, t, locale, maxParts);
  const { additions, removals } = aggregateFileEditStats(tools);
  return {
    text,
    additions,
    removals,
    hasDiff: additions > 0 || removals > 0,
  };
}

/**
 * The transcript display profiles `/display` offers.
 *
 * ## Why profiles and not a fifth setting
 *
 * The renderer reads four orthogonal switches — thinking visible, blocks open
 * by default, result bodies drawn, how many calls of a run get a row. A reader
 * does not tune those one at a time; they want a *shape* for the transcript and
 * then the odd exception. So `/display` names four combinations of the same
 * keys, and `/settings` keeps owning the keys themselves.
 *
 * ## Why the current profile is DERIVED
 *
 * There is no `cli.tui.displayProfile` key. Storing one would put two sources of
 * truth in the settings table — the profile and the four switches — and they
 * would disagree the first time a row is cycled from `/settings`, which is the
 * exact failure the shared Desktop/TUI keys make loud: a stored profile would
 * say `Standard` while the screen showed compact. Reading the profile out of the
 * vector means a profile row and a settings row can only ever report the same
 * thing, and a hand-tuned transcript honestly reports `Custom` instead of the
 * nearest neighbour.
 */

import type { ToolGroupMode } from './transcript-view.js';
import {
  TUI_EXPAND_BLOCKS_SETTING,
  TUI_SHOW_THINKING_SETTING,
  TUI_SHOW_TOOL_RESULTS_SETTING,
  TUI_TOOL_GROUP_MODE_SETTING,
} from './preferences.js';

export type DisplayProfileId = 'detailed' | 'standard' | 'compact' | 'running';

/** A named point in the four-switch space, plus the words the menu shows for it. */
export interface DisplayProfile {
  readonly id: DisplayProfileId;
  readonly label: string;
  /** One line saying what the reader loses, since every profile gives something up. */
  readonly detail: string;
  readonly showThinking: boolean;
  readonly expandBlocks: boolean;
  readonly showToolResults: boolean;
  readonly toolGroupMode: ToolGroupMode;
}

/**
 * Listed in the order the menu shows them: most content first, least last.
 *
 * `standard` is the same vector as `DEFAULT_TUI_PREFERENCES`, so a fresh
 * install is on a named profile rather than on an unnamed `Custom`.
 */
export const DISPLAY_PROFILES: readonly DisplayProfile[] = [
  {
    id: 'detailed',
    label: 'Detailed',
    detail: 'Everything open: full reasoning and every tool result.',
    showThinking: true,
    expandBlocks: true,
    showToolResults: true,
    toolGroupMode: 'full',
  },
  {
    id: 'standard',
    label: 'Standard',
    detail: 'Reasoning and results one line each, opened by key or by [+].',
    showThinking: true,
    expandBlocks: false,
    showToolResults: false,
    toolGroupMode: 'full',
  },
  {
    id: 'compact',
    label: 'Compact',
    detail: 'No reasoning; every call keeps its line, nothing under it.',
    showThinking: false,
    expandBlocks: false,
    showToolResults: false,
    toolGroupMode: 'names',
  },
  {
    id: 'running',
    label: 'Live only',
    detail: 'One line per turn: the call in flight, with settled batches folded to their header.',
    showThinking: false,
    expandBlocks: false,
    showToolResults: false,
    toolGroupMode: 'running',
  },
];

/** The four switches, as seen by the renderer or by the settings table. */
export interface TranscriptVector {
  readonly showThinking: boolean;
  readonly expandBlocks: boolean;
  readonly showToolResults: boolean;
  readonly toolGroupMode: ToolGroupMode;
}

export function profileById(id: DisplayProfileId): DisplayProfile {
  const found = DISPLAY_PROFILES.find((profile) => profile.id === id);
  // Every id in the union is in the list; the throw is a guard against a new
  // profile added without its entry, not against user input.
  if (found === undefined) throw new Error(`Unknown display profile: ${id}`);
  return found;
}

/**
 * Which profile this vector is, or `custom`.
 *
 * Exact match only. A nearest-match would relabel a transcript the user tuned
 * by hand as one they did not tune, and the row's value is the one thing the
 * menu claims to report truthfully.
 */
export function resolveDisplayProfile(vector: TranscriptVector): DisplayProfileId | 'custom' {
  const match = DISPLAY_PROFILES.find((profile) => profile.showThinking === vector.showThinking
    && profile.expandBlocks === vector.expandBlocks
    && profile.showToolResults === vector.showToolResults
    && profile.toolGroupMode === vector.toolGroupMode);
  return match?.id ?? 'custom';
}

/**
 * The settings to write to pick a profile — all four keys, every time.
 *
 * Writing only the switches that differ would leave a stored `toolGroupMode`
 * from an older build in place, so "choose Standard" would mean different things
 * on two installs. A profile is a full vector; it is applied as one.
 */
export function displayProfileSettings(id: DisplayProfileId): Readonly<Record<string, string>> {
  const profile = profileById(id);
  return {
    [TUI_SHOW_THINKING_SETTING]: String(profile.showThinking),
    [TUI_EXPAND_BLOCKS_SETTING]: String(profile.expandBlocks),
    [TUI_SHOW_TOOL_RESULTS_SETTING]: String(profile.showToolResults),
    [TUI_TOOL_GROUP_MODE_SETTING]: profile.toolGroupMode,
  };
}

/** The same vector, shaped for `applyTuiPreferences` (booleans only — the renderer patch). */
export function displayProfilePatch(id: DisplayProfileId): TranscriptVector {
  const profile = profileById(id);
  const { showThinking, expandBlocks, showToolResults, toolGroupMode } = profile;
  return { showThinking, expandBlocks, showToolResults, toolGroupMode };
}

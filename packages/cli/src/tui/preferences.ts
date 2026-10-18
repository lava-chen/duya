/** Persistent preferences for the standalone chat TUI. */

import type { HostSessionHttpClient } from '@duya/host/http-client';
import { normalizeEffort, resolveThemeName, type EffortLevel, type ThemeName } from './theme.js';

export const TUI_THEME_SETTING = 'cli.tui.theme';
export const TUI_DISPLAY_MODE_SETTING = 'cli.tui.displayMode';
/**
 * Transcript and composer preferences that take effect the moment they change.
 *
 * These exist because the terminal has no second surface to configure them on:
 * the Desktop puts half of them in panels and the rest in the composer, and
 * without them a user who dislikes thinking blocks or wants a taller input box
 * has no way to say so at all. Each one is a real branch in the renderer, not a
 * value that is stored and ignored — `TUIApp.applyTuiPreferences` is the single
 * place that moves them.
 */
export const TUI_SHOW_THINKING_SETTING = 'cli.tui.showThinking';
export const TUI_EXPAND_BLOCKS_SETTING = 'cli.tui.expandBlocks';
export const TUI_SHOW_TOOL_RESULTS_SETTING = 'cli.tui.showToolResults';
/** Printed once at startup; off for people who pipe `duya chat` into something. */
export const TUI_STARTUP_BANNER_SETTING = 'cli.tui.startupBanner';
export const TUI_COMPLETION_ROWS_SETTING = 'cli.tui.completionRows';
export const TUI_INPUT_ROWS_SETTING = 'cli.tui.inputRows';
/**
 * Saved reasoning effort (desktop parity: auto/low/medium/high/max).
 *
 * Persisted rather than session-scoped because it describes the user's appetite
 * for a given model, not a property of one conversation. `auto` is stored as the
 * literal string so "I chose auto" and "nothing was ever saved" are the same
 * answer without a second sentinel.
 */
export const TUI_EFFORT_SETTING = 'cli.tui.effort';
/**
 * Per-model effort defaults, as one JSON object under a single key.
 *
 * One key rather than `cli.tui.effort.<modelId>` because the settings endpoint
 * is a flat string map with no way to list or delete by prefix: a per-model key
 * could be written but never enumerated, so a model the user has not touched
 * since last year would keep a default they cannot see or clear. A single
 * object is also the only shape in which "clear the override" is expressible
 * at all — it is the absence of the key.
 *
 * `auto` is never stored: it means "no override, follow the global value".
 */
export const TUI_EFFORT_BY_MODEL_SETTING = 'cli.tui.effortByModel';

export type TuiThemePreference = 'system' | ThemeName;
export type TuiDisplayMode = 'fullscreen' | 'inline';

export interface TuiPreferences {
  readonly theme: TuiThemePreference;
  readonly displayMode: TuiDisplayMode;
  readonly effort: EffortLevel;
  /**
   * Default effort per model id, overriding `effort` for that model only.
   *
   * Absent means "follow `effort`", which is why there is no `auto` entry: the
   * two answers a row has to distinguish are "this model has its own default"
   * and "it does not", and an explicit `auto` would be a third.
   */
  readonly effortByModel: Readonly<Record<string, EffortLevel>>;
  /** Thinking blocks in the transcript; off hides them entirely. */
  readonly showThinking: boolean;
  /** Per-block expansion on by default (the same switch `expand-all` toggles). */
  readonly expandBlocks: boolean;
  /** Tool result bodies without per-block expansion. */
  readonly showToolResults: boolean;
  /** The `session … type a message` line printed on startup. */
  readonly startupBanner: boolean;
  /** Visible rows in the completion popup. */
  readonly completionRows: number;
  /** Rows the input box may grow to before it scrolls internally. */
  readonly inputRows: number;
}

/**
 * What the running TUI actually uses: the saved preferences with the two
 * environment-overridable ones resolved.
 *
 * It extends `TuiPreferences` rather than repeating its fields so `/settings`
 * can read one object: a menu row that showed the saved value while the
 * renderer used the resolved one would disagree with what is on screen.
 */
export interface EffectiveTuiPreferences extends TuiPreferences {
  readonly theme: ThemeName;
  readonly themeOverriddenByEnvironment: boolean;
  readonly displayModeOverriddenByEnvironment: boolean;
}

export const DEFAULT_TUI_PREFERENCES: TuiPreferences = {
  theme: 'system',
  // Inline, because that is what a terminal chat is supposed to look like: the
  // conversation scrolls in the terminal's own scrollback, and the composer
  // plus its footer are docked at the bottom of the page. The full-screen mode
  // (alternate buffer, bordered transcript) is still available via /settings,
  // but it is no longer the shape a first run lands in.
  displayMode: 'inline',
  effort: 'auto',
  effortByModel: {},
  // Thinking is shown and tool results are collapsed behind it: the transcript
  // reads as a conversation with the working visible, not as a log dump.
  showThinking: true,
  expandBlocks: false,
  showToolResults: false,
  startupBanner: true,
  completionRows: 8,
  inputRows: 8,
};

/** Completion popup rows: fewer than three is unusable, more than twelve covers the screen. */
export const COMPLETION_ROWS_RANGE = { min: 3, max: 12 } as const;
/** Input box rows: two is a single wrapped line, sixteen is a small editor. */
export const INPUT_ROWS_RANGE = { min: 2, max: 16 } as const;

/** `'false' | '0' | 'off'` are the ways a setting endpoint can say no. */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no') return false;
  if (normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes') return true;
  return fallback;
}

function parseRangedInt(
  value: string | undefined,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(range.min, Math.min(range.max, parsed));
}

/**
 * Parse the per-model effort map.
 *
 * Every failure mode here degrades to "no overrides" rather than throwing:
 * this is a preference read from a remote endpoint, and a malformed value must
 * cost the user their defaults, never their session.
 */
export function parseEffortByModel(
  value: string | undefined,
): Readonly<Record<string, EffortLevel>> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const result: Record<string, EffortLevel> = {};
  for (const [modelId, level] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof level !== 'string') continue;
    const normalized = normalizeEffort(level);
    // `auto` is the "no override" answer, so it is dropped rather than stored.
    if (normalized === 'auto') continue;
    result[modelId] = normalized;
  }
  return result;
}

/** Stable key order, so the stored string does not churn between writes. */
export function serializeEffortByModel(
  map: Readonly<Record<string, EffortLevel>>,
): string {
  const entries = Object.entries(map)
    .filter(([, level]) => level !== 'auto')
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

/** The effort in force for a model: its override, or the global value. */
export function effortForModel(preferences: TuiPreferences, modelId: string | undefined): EffortLevel {
  if (modelId !== undefined && modelId !== '') {
    const override = preferences.effortByModel[modelId];
    if (override !== undefined) return override;
  }
  return preferences.effort;
}

export function parseTuiPreferences(values: Readonly<Record<string, string>>): TuiPreferences {
  const storedTheme = values[TUI_THEME_SETTING];
  const storedDisplayMode = values[TUI_DISPLAY_MODE_SETTING];
  const storedEffort = values[TUI_EFFORT_SETTING];
  return {
    theme: storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system'
      ? storedTheme
      : DEFAULT_TUI_PREFERENCES.theme,
    displayMode: storedDisplayMode === 'inline' || storedDisplayMode === 'fullscreen'
      ? storedDisplayMode
      : DEFAULT_TUI_PREFERENCES.displayMode,
    // Unknown values degrade to auto rather than to a level the model may not
    // support: a saved `xhigh` from a stronger model must not start a run that
    // the current one rejects.
    effort: storedEffort === undefined || storedEffort === ''
      ? DEFAULT_TUI_PREFERENCES.effort
      : normalizeEffort(storedEffort),
    effortByModel: parseEffortByModel(values[TUI_EFFORT_BY_MODEL_SETTING]),
    showThinking: parseBoolean(values[TUI_SHOW_THINKING_SETTING], DEFAULT_TUI_PREFERENCES.showThinking),
    expandBlocks: parseBoolean(values[TUI_EXPAND_BLOCKS_SETTING], DEFAULT_TUI_PREFERENCES.expandBlocks),
    showToolResults: parseBoolean(values[TUI_SHOW_TOOL_RESULTS_SETTING], DEFAULT_TUI_PREFERENCES.showToolResults),
    startupBanner: parseBoolean(values[TUI_STARTUP_BANNER_SETTING], DEFAULT_TUI_PREFERENCES.startupBanner),
    completionRows: parseRangedInt(values[TUI_COMPLETION_ROWS_SETTING], DEFAULT_TUI_PREFERENCES.completionRows, COMPLETION_ROWS_RANGE),
    inputRows: parseRangedInt(values[TUI_INPUT_ROWS_SETTING], DEFAULT_TUI_PREFERENCES.inputRows, INPUT_ROWS_RANGE),
  };
}

export async function readTuiPreferences(client: HostSessionHttpClient): Promise<TuiPreferences> {
  return parseTuiPreferences(await client.getSettings());
}

/** Environment variables take precedence over saved preferences. */
export function resolveEffectiveTuiPreferences(
  preferences: TuiPreferences,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveTuiPreferences {
  const environmentTheme = env['DUYA_TUI_THEME'];
  const themeOverriddenByEnvironment = environmentTheme === 'dark' || environmentTheme === 'light';
  const theme: ThemeName = environmentTheme === 'dark' || environmentTheme === 'light'
    ? environmentTheme
    : preferences.theme === 'system'
      ? resolveThemeName(env)
      : preferences.theme;

  const environmentDisplayMode = env['DUYA_TUI_INLINE'];
  const displayModeOverriddenByEnvironment = environmentDisplayMode !== undefined;
  const displayMode = environmentDisplayMode !== undefined
    ? environmentDisplayMode === ''
      || environmentDisplayMode === '0'
      || environmentDisplayMode.toLowerCase() === 'false'
      ? 'fullscreen'
      : 'inline'
    : preferences.displayMode;

  return {
    ...preferences,
    theme,
    displayMode,
    // Effort has no environment override: unlike theme and display mode it
    // changes what a run COSTS, and a shell variable silently raising that is
    // not a capability probe, it is a surprise on the bill.
    themeOverriddenByEnvironment,
    displayModeOverriddenByEnvironment,
  };
}

export function describeTuiTheme(theme: TuiThemePreference): string {
  if (theme === 'system') return 'Match terminal';
  return theme === 'dark' ? 'Dark' : 'Light';
}

export function describeTuiDisplayMode(mode: TuiDisplayMode): string {
  return mode === 'inline' ? 'Inline scrollback' : 'Full screen';
}

/** Menu spelling of a boolean: pi renders `true`/`false`; words read better. */
export function describeOnOff(value: boolean): string {
  return value ? 'Shown' : 'Hidden';
}

export function describeEnabled(value: boolean): string {
  return value ? 'On' : 'Off';
}

/** Menu spelling of a row count, e.g. `8 rows`. */
export function describeRows(value: number): string {
  return `${value} rows`;
}

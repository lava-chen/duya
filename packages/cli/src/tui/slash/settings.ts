/**
 * `/settings` — one list of switches, changed in place.
 *
 * ## Why this shape
 *
 * pi's settings are a single `SettingsList`: the row shows the value, Enter
 * cycles it, and the change lands while you are still looking at the row. The
 * previous shape here was a menu of menus — pick "Theme", pick "Dark", land
 * back on the parent — which is three keystrokes to answer one question and
 * hides every current value behind a submenu.
 *
 * ## Why most rows take effect immediately
 *
 * A setting you have to restart to see is a setting you cannot tune. Theme and
 * display mode are the two exceptions and they say so in their detail line:
 * both are decided when the terminal surface is built, and rebuilding it under
 * a live stream is a different change than this menu is.
 */

import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import type { TuiSettingsRow } from '../TUIApp.js';
import type { CommandLocale } from '@duya/command-catalog';
import { EFFORT_LABELS, normalizeEffort, type EffortLevel, type ThemeName } from '../theme.js';
import {
  COMPLETION_ROWS_RANGE,
  describeEnabled,
  describeOnOff,
  describeRows,
  describeTuiDisplayMode,
  describeTuiTheme,
  effortForModel,
  INPUT_ROWS_RANGE,
  parseTuiPreferences,
  serializeEffortByModel,
  TUI_COMPLETION_ROWS_SETTING,
  TUI_DISPLAY_MODE_SETTING,
  TUI_EFFORT_BY_MODEL_SETTING,
  TUI_EFFORT_SETTING,
  TUI_EXPAND_BLOCKS_SETTING,
  TUI_INPUT_ROWS_SETTING,
  TUI_LOCALE_SETTING,
  TUI_SHOW_THINKING_SETTING,
  TUI_SHOW_TOOL_RESULTS_SETTING,
  TUI_STARTUP_BANNER_SETTING,
  TUI_THEME_SETTING,
  type TuiDisplayMode,
  type TuiPreferences,
  type TuiThemePreference,
} from '../preferences.js';

/** Steps a row-count row cycles through. Kept short enough to reach by hand. */
const COMPLETION_ROW_CHOICES: readonly number[] = [5, 7, 8, 10, 12];
const INPUT_ROW_CHOICES: readonly number[] = [4, 6, 8, 12, 16];

/** Effort levels offered when the model does not declare any. */
const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[] = ['auto', 'low', 'medium', 'high', 'max'];

type SettingId =
  | 'language'
  | 'theme'
  | 'display-mode'
  | 'effort'
  | 'model-effort'
  | 'show-thinking'
  | 'expand-blocks'
  | 'tool-results'
  | 'startup-banner'
  | 'completion-rows'
  | 'input-rows';

interface LivePreferences {
  /** What the screen is actually painted with, after the terminal's fallback. */
  readonly theme: string;
  readonly showThinking: boolean;
  readonly expandBlocks: boolean;
  readonly showToolResults: boolean;
  readonly completionRows: number;
  readonly inputRows: number;
}

/** What the running TUI can be told to change right now. */
interface LivePatch {
  readonly effort?: string | null;
  readonly locale?: CommandLocale;
  /** `null` = follow the environment, which is what the `system` row means. */
  readonly theme?: ThemeName | null;
  readonly showThinking?: boolean;
  readonly expandBlocks?: boolean;
  readonly showToolResults?: boolean;
  readonly completionRows?: number;
  readonly inputRows?: number;
}

/** The two halves of one change: what the TUI applies, what the Host saves. */
interface SettingsChange {
  readonly patch: LivePatch;
  readonly settings: Readonly<Record<string, string>>;
}

/**
 * The rows whose effect waits for a restart, and why.
 *
 * Deliberately NOT the theme: the palette is looked up per paint, so it
 * switches in place. What cannot switch is anything that decides which surface
 * object exists — display mode builds the inline or full-screen surface once.
 */
const RESTART_DETAIL = 'Applies on the next launch — the terminal surface is built once.';

/** `system` is a REQUEST to follow the environment, so it reaches the TUI as `null`. */
function themeToLive(theme: TuiThemePreference): ThemeName | null {
  return theme === 'system' ? null : theme;
}

function nextIn<T>(list: readonly T[], current: T): T {
  const index = list.indexOf(current);
  return list[(index + 1) % list.length] as T;
}

class SettingsState {
  preferences: TuiPreferences;
  live: LivePreferences;
  effortLevels: readonly EffortLevel[] = DEFAULT_EFFORT_LEVELS;
  /**
   * The model the per-model row is editing.
   *
   * Effort is the one preference whose right answer depends on which model is
   * in front of you — `max` on a cheap model is a bill, `low` on a reasoning
   * model is a worse answer — so the row exists per model rather than once.
   */
  readonly modelId: string;

  constructor(preferences: TuiPreferences, live: LivePreferences, modelId: string) {
    this.preferences = preferences;
    this.live = live;
    this.modelId = modelId;
  }

  /** The global effort level: what a model without its own override gets. */
  get effort(): EffortLevel {
    return this.preferences.effort;
  }

  /** This model's override, or null when it follows the global row. */
  get effortOverride(): EffortLevel | null {
    const override = this.preferences.effortByModel[this.modelId];
    return override === undefined || override === 'auto' ? null : override;
  }

  /** What a run would actually start with if it were sent right now. */
  get effectiveEffort(): EffortLevel {
    return effortForModel(this.preferences, this.modelId);
  }

  /** The model as a row label; an unnamed session still needs a noun. */
  get modelLabel(): string {
    return this.modelId === '' ? 'this model' : this.modelId;
  }

  rows(): readonly TuiSettingsRow[] {
    const prefs = this.preferences;
    const live = this.live;
    return [
      {
        id: 'language',
        label: prefs.locale === 'zh' ? '语言' : 'Language',
        valueLabel: prefs.locale === 'zh' ? '中文' : 'English',
        detail: prefs.locale === 'zh'
          ? '桌面端和 TUI 共用的界面语言，立即生效。'
          : 'Language used by the Desktop and TUI. Applies immediately.',
      },
      {
        id: 'theme',
        label: 'Theme',
        valueLabel: describeTuiTheme(prefs.theme),
        detail: 'Colour theme. Switches immediately — on a terminal without a 256-colour palette, light falls back to dark.',
      },
      {
        id: 'display-mode',
        label: 'Display mode',
        valueLabel: describeTuiDisplayMode(prefs.displayMode),
        detail: `Inline scrollback keeps the conversation in the terminal's own history; full screen takes the whole window. ${RESTART_DETAIL}`,
      },
      {
        id: 'effort',
        label: 'Reasoning effort',
        valueLabel: EFFORT_LABELS[this.effort],
        // When this model has its own default, say so here rather than letting
        // the two rows look like they disagree: the global row is what every
        // OTHER model gets, and that is not obvious from two similar labels.
        detail: this.effortOverride === null
          ? 'How much thinking the next turns buy. Also the colour of the composer border.'
          : `Default for every other model — ${this.modelLabel} overrides it with ${EFFORT_LABELS[this.effortOverride]}.`,
      },
      {
        id: 'model-effort',
        label: `Effort · ${this.modelLabel}`,
        valueLabel: this.effortOverride === null
          ? this.effort === 'auto'
            ? 'Follows default'
            : `Follows default · ${EFFORT_LABELS[this.effort]}`
          : EFFORT_LABELS[this.effortOverride],
        detail: `Default effort for ${this.modelLabel} only, overriding the row above. Also the composer border colour. Auto clears it and follows the global default again.`,
      },
      {
        id: 'show-thinking',
        label: 'Thinking blocks',
        valueLabel: describeOnOff(live.showThinking),
        detail: 'Hidden drops reasoning from the transcript entirely; the run still thinks.',
      },
      {
        id: 'expand-blocks',
        label: 'Expand blocks',
        valueLabel: describeEnabled(live.expandBlocks),
        detail: 'Open every block by default — thinking in full and every tool result. Same switch the expand key toggles.',
      },
      {
        id: 'tool-results',
        label: 'Tool results',
        valueLabel: describeOnOff(live.showToolResults),
        detail: "Show a tool's output underneath its call without expanding anything else.",
      },
      {
        id: 'startup-banner',
        label: 'Startup banner',
        valueLabel: describeEnabled(prefs.startupBanner),
        detail: `The session line printed on launch. ${RESTART_DETAIL}`,
      },
      {
        id: 'completion-rows',
        label: 'Completion rows',
        valueLabel: describeRows(live.completionRows),
        detail: `Rows the completion popup shows at once (${COMPLETION_ROWS_RANGE.min}-${COMPLETION_ROWS_RANGE.max}).`,
      },
      {
        id: 'input-rows',
        label: 'Input box rows',
        valueLabel: describeRows(live.inputRows),
        detail: `Rows the input box grows to before it scrolls (${INPUT_ROWS_RANGE.min}-${INPUT_ROWS_RANGE.max}).`,
      },
    ];
  }

  /**
   * Advance one row and return what has to reach the TUI and the settings
   * endpoint for the change to be real.
   */
  cycle(id: SettingId): SettingsChange {
    switch (id) {
      case 'language': {
        const locale: CommandLocale = this.preferences.locale === 'en' ? 'zh' : 'en';
        this.preferences = { ...this.preferences, locale };
        return {
          patch: { locale },
          settings: { [TUI_LOCALE_SETTING]: locale },
        };
      }
      case 'theme': {
        const theme = nextIn<TuiThemePreference>(['system', 'dark', 'light'], this.preferences.theme);
        this.preferences = { ...this.preferences, theme };
        return {
          // Applied live: the palette is read per paint, so a switch is a
          // repaint rather than a restart. `system` reaches the TUI as `null`,
          // which makes it re-probe instead of pinning whatever it resolved at
          // launch.
          patch: { theme: themeToLive(theme) },
          settings: { [TUI_THEME_SETTING]: theme },
        };
      }
      case 'display-mode': {
        const displayMode = nextIn<TuiDisplayMode>(['inline', 'fullscreen'], this.preferences.displayMode);
        this.preferences = { ...this.preferences, displayMode };
        return { patch: {}, settings: { [TUI_DISPLAY_MODE_SETTING]: displayMode } };
      }
      case 'effort': {
        const level = nextIn(this.effortLevels, this.effort);
        this.preferences = { ...this.preferences, effort: level };
        // The border follows the EFFECTIVE level, not this row: if the current
        // model has an override, cycling the global row must not repaint it.
        const effective = effortForModel(this.preferences, this.modelId);
        return {
          patch: { effort: effective === 'auto' ? null : effective },
          settings: { [TUI_EFFORT_SETTING]: level },
        };
      }
      case 'model-effort': {
        // An unknown model id has no key worth writing: the override could be
        // stored but never applied, so the row is inert rather than lying.
        if (this.modelId === '') return { patch: {}, settings: {} };
        // `nextIn` on a level the model does not declare lands on `auto`,
        // which is the honest answer: an override for a level this model has
        // never heard of is worse than none.
        const level = nextIn(this.effortLevels, this.effortOverride ?? 'auto');
        const effortByModel: Record<string, EffortLevel> = { ...this.preferences.effortByModel };
        if (level === 'auto') delete effortByModel[this.modelId];
        else effortByModel[this.modelId] = level;
        this.preferences = { ...this.preferences, effortByModel };
        const effective = effortForModel(this.preferences, this.modelId);
        return {
          patch: { effort: effective === 'auto' ? null : effective },
          settings: { [TUI_EFFORT_BY_MODEL_SETTING]: serializeEffortByModel(effortByModel) },
        };
      }
      case 'show-thinking': {
        const showThinking = !this.live.showThinking;
        this.live = { ...this.live, showThinking };
        this.preferences = { ...this.preferences, showThinking };
        return { patch: { showThinking }, settings: { [TUI_SHOW_THINKING_SETTING]: String(showThinking) } };
      }
      case 'expand-blocks': {
        const expandBlocks = !this.live.expandBlocks;
        this.live = { ...this.live, expandBlocks };
        this.preferences = { ...this.preferences, expandBlocks };
        return { patch: { expandBlocks }, settings: { [TUI_EXPAND_BLOCKS_SETTING]: String(expandBlocks) } };
      }
      case 'tool-results': {
        const showToolResults = !this.live.showToolResults;
        this.live = { ...this.live, showToolResults };
        this.preferences = { ...this.preferences, showToolResults };
        return { patch: { showToolResults }, settings: { [TUI_SHOW_TOOL_RESULTS_SETTING]: String(showToolResults) } };
      }
      case 'startup-banner': {
        const startupBanner = !this.preferences.startupBanner;
        this.preferences = { ...this.preferences, startupBanner };
        return { patch: {}, settings: { [TUI_STARTUP_BANNER_SETTING]: String(startupBanner) } };
      }
      case 'completion-rows': {
        const completionRows = nextIn(COMPLETION_ROW_CHOICES, this.live.completionRows);
        this.live = { ...this.live, completionRows };
        this.preferences = { ...this.preferences, completionRows };
        return { patch: { completionRows }, settings: { [TUI_COMPLETION_ROWS_SETTING]: String(completionRows) } };
      }
      case 'input-rows': {
        const inputRows = nextIn(INPUT_ROW_CHOICES, this.live.inputRows);
        this.live = { ...this.live, inputRows };
        this.preferences = { ...this.preferences, inputRows };
        return { patch: { inputRows }, settings: { [TUI_INPUT_ROWS_SETTING]: String(inputRows) } };
      }
    }
  }
}

/** Persist and apply. A failed write is reported, never swallowed silently. */
function commit(ctx: TuiSlashContext, change: SettingsChange): void {
  ctx.tui.applyTuiPreferences?.(change.patch);
  ctx.tui.refresh?.();
  for (const [key, value] of Object.entries(change.settings)) {
    void ctx.client.setSetting(key, value).catch((error: unknown) => {
      ctx.tui.printError(
        `Applied now, but could not save ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

const SETTINGS_COMMAND: TuiSlashCommandDef = {
  name: 'settings',
  description: 'Configure the terminal: theme, display, effort, transcript',
  group: 'Settings',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    if (args.trim() !== '') {
      ctx.tui.printNotice('Use /settings to open the settings list.');
      return { kind: 'handled' };
    }

    let saved: TuiPreferences;
    try {
      saved = parseTuiPreferences(await ctx.client.getSettings());
    } catch (error) {
      ctx.tui.printError(
        `Could not read TUI settings: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'handled' };
    }
    // The Desktop may have changed the shared locale since this TUI started.
    // Opening Settings is the next settings read, so bring command rendering
    // up to date before showing the row values.
    ctx.tui.applyTuiPreferences?.({ locale: saved.locale });

    // Effort levels are per model, and the list is read once up front: the row
    // cycles synchronously, and an async step inside Enter would let the menu
    // repaint with the old value before the new one arrives.
    const state = new SettingsState(saved, ctx.tui.liveTuiPreferences?.() ?? {
      theme: saved.theme,
      showThinking: saved.showThinking,
      expandBlocks: saved.expandBlocks,
      showToolResults: saved.showToolResults,
      completionRows: saved.completionRows,
      inputRows: saved.inputRows,
    }, ctx.session.model ?? '');
    try {
      const capability = await ctx.client.getProviderModelCapability(ctx.session.providerId, ctx.session.model);
      const declared = (capability?.reasoningEffortOptions ?? [])
        .map((value) => normalizeEffort(value))
        .filter((level) => level !== 'auto');
      if (declared.length > 0) {
        state.effortLevels = ['auto', ...[...new Set(declared)]];
      }
    } catch {
      // Advisory: the four levels the Desktop offers stay on the row.
    }

    if (ctx.tui.openSettings === undefined) {
      // No live list (a headless host): pick a row, cycle it once, done.
      const picked = await ctx.tui.choose('Settings', state.rows().map((row) => ({
        label: `${row.label} · ${row.valueLabel}`,
        value: row.id,
      })));
      if (picked !== null) commit(ctx, state.cycle(picked as SettingId));
      return { kind: 'handled' };
    }

    await ctx.tui.openSettings({
      title: 'Settings',
      rows: state.rows(),
      footer: 'type to filter · Enter/Space change · Esc close',
      onActivate: (id) => {
        commit(ctx, state.cycle(id as SettingId));
        return state.rows();
      },
    });
    return { kind: 'handled' };
  },
};

export const SETTINGS_COMMANDS: readonly TuiSlashCommandDef[] = [SETTINGS_COMMAND];

/** The row ids, for tests. */
export const SETTINGS_ROW_IDS: readonly SettingId[] = [
  'language',
  'theme',
  'display-mode',
  'effort',
  'model-effort',
  'show-thinking',
  'expand-blocks',
  'tool-results',
  'startup-banner',
  'completion-rows',
  'input-rows',
];

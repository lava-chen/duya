/** `/settings` — choose and persist terminal appearance preferences. */

import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import {
  describeTuiDisplayMode,
  describeTuiTheme,
  readTuiPreferences,
  resolveEffectiveTuiPreferences,
  TUI_DISPLAY_MODE_SETTING,
  TUI_THEME_SETTING,
  type TuiDisplayMode,
  type TuiPreferences,
  type TuiThemePreference,
} from '../preferences.js';

function describeSavedTheme(preferences: TuiPreferences, activeTheme: string, overridden: boolean): string {
  const saved = describeTuiTheme(preferences.theme);
  return overridden
    ? `${saved} (active: ${activeTheme}, environment override)`
    : preferences.theme === 'system'
      ? `${saved} (active: ${activeTheme.toLowerCase()})`
      : saved;
}

function describeSavedDisplayMode(
  preferences: TuiPreferences,
  activeMode: TuiDisplayMode,
  overridden: boolean,
): string {
  const saved = describeTuiDisplayMode(preferences.displayMode);
  return overridden
    ? `${saved} (active: ${describeTuiDisplayMode(activeMode)}, environment override)`
    : saved;
}

async function chooseTheme(ctx: TuiSlashContext, current: TuiThemePreference): Promise<TuiThemePreference | null> {
  const choices: Array<{ label: string; value: TuiThemePreference }> = [
    { label: `Match terminal${current === 'system' ? '  (current)' : ''}`, value: 'system' },
    { label: `Dark${current === 'dark' ? '  (current)' : ''}`, value: 'dark' },
    { label: `Light${current === 'light' ? '  (current)' : ''}`, value: 'light' },
  ];
  return await ctx.tui.choose('Theme · saved preference', choices) as TuiThemePreference | null;
}

async function chooseDisplayMode(
  ctx: TuiSlashContext,
  current: TuiDisplayMode,
): Promise<TuiDisplayMode | null> {
  const choices: Array<{ label: string; value: TuiDisplayMode }> = [
    {
      label: `Full screen${current === 'fullscreen' ? '  (current)' : ''}`,
      value: 'fullscreen',
    },
    {
      label: `Inline scrollback${current === 'inline' ? '  (current)' : ''}`,
      value: 'inline',
    },
  ];
  return await ctx.tui.choose('Display mode · saved preference', choices) as TuiDisplayMode | null;
}

const SETTINGS_COMMAND: TuiSlashCommandDef = {
  name: 'settings',
  description: 'Configure terminal theme and display mode',
  group: 'Settings',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    if (args.trim() !== '') {
      ctx.tui.printNotice('Use /settings to open the selectable settings menu.');
      return { kind: 'handled' };
    }

    let preferences: TuiPreferences;
    try {
      preferences = await readTuiPreferences(ctx.client);
    } catch (error) {
      ctx.tui.printError(
        `Could not read TUI settings: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'handled' };
    }

    while (true) {
      const effective = resolveEffectiveTuiPreferences(preferences);
      const action = await ctx.tui.choose('Settings · changes apply on next launch', [
        {
          label: `Theme · ${describeSavedTheme(
            preferences,
            effective.theme,
            effective.themeOverriddenByEnvironment,
          )}`,
          value: 'theme',
        },
        {
          label: `Display mode · ${describeSavedDisplayMode(
            preferences,
            effective.displayMode,
            effective.displayModeOverriddenByEnvironment,
          )}`,
          value: 'display-mode',
        },
        { label: 'Done', value: 'done' },
      ]);

      if (action === null || action === 'done') return { kind: 'handled' };

      try {
        if (action === 'theme') {
          const theme = await chooseTheme(ctx, preferences.theme);
          if (theme === null || theme === preferences.theme) continue;
          await ctx.client.setSetting(TUI_THEME_SETTING, theme);
          preferences = { ...preferences, theme };
          ctx.tui.printNotice(`Theme saved as ${describeTuiTheme(theme)}. It takes effect next launch.`);
        } else {
          const displayMode = await chooseDisplayMode(ctx, preferences.displayMode);
          if (displayMode === null || displayMode === preferences.displayMode) continue;
          await ctx.client.setSetting(TUI_DISPLAY_MODE_SETTING, displayMode);
          preferences = { ...preferences, displayMode };
          ctx.tui.printNotice(
            `Display mode saved as ${describeTuiDisplayMode(displayMode)}. It takes effect next launch.`,
          );
        }
      } catch (error) {
        ctx.tui.printError(
          `Could not save TUI settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  },
};

export const SETTINGS_COMMANDS: readonly TuiSlashCommandDef[] = [SETTINGS_COMMAND];

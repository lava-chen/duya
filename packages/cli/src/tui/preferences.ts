/** Persistent preferences for the standalone chat TUI. */

import type { HostSessionHttpClient } from '@duya/host/http-client';
import { resolveThemeName, type ThemeName } from './theme.js';

export const TUI_THEME_SETTING = 'cli.tui.theme';
export const TUI_DISPLAY_MODE_SETTING = 'cli.tui.displayMode';

export type TuiThemePreference = 'system' | ThemeName;
export type TuiDisplayMode = 'fullscreen' | 'inline';

export interface TuiPreferences {
  readonly theme: TuiThemePreference;
  readonly displayMode: TuiDisplayMode;
}

export interface EffectiveTuiPreferences {
  readonly theme: ThemeName;
  readonly displayMode: TuiDisplayMode;
  readonly themeOverriddenByEnvironment: boolean;
  readonly displayModeOverriddenByEnvironment: boolean;
}

export const DEFAULT_TUI_PREFERENCES: TuiPreferences = {
  theme: 'system',
  displayMode: 'fullscreen',
};

export function parseTuiPreferences(values: Readonly<Record<string, string>>): TuiPreferences {
  const storedTheme = values[TUI_THEME_SETTING];
  const storedDisplayMode = values[TUI_DISPLAY_MODE_SETTING];
  return {
    theme: storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system'
      ? storedTheme
      : DEFAULT_TUI_PREFERENCES.theme,
    displayMode: storedDisplayMode === 'inline' || storedDisplayMode === 'fullscreen'
      ? storedDisplayMode
      : DEFAULT_TUI_PREFERENCES.displayMode,
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
    theme,
    displayMode,
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

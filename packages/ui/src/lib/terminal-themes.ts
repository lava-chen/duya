// terminal-themes.ts - colour themes and the CSS-var bridge for the sidebar
// terminal. xterm themes are plain objects, so the presets below are static
// palettes; the special 'auto' preset follows the application light/dark
// variables instead of hard-coding a palette.

import type { ITheme } from '@xterm/xterm';
import type { TranslationKey } from '@/i18n';
import type { TerminalThemeId } from '@/stores/terminal-appearance-store';

export interface TerminalThemePreset {
  id: TerminalThemeId;
  labelKey: TranslationKey;
  /** Preview swatch: [background, foreground, accent]. */
  swatch: [string, string, string];
  /** Fixed palette. Absent for 'auto', which is resolved at runtime. */
  theme?: ITheme;
}

/** The ANSI palette shared by the 'auto' preset (matches the app accent). */
const AUTO_ANSI = {
  black: '#1f2430',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#414868',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ffcf7a',
  brightBlue: '#8db0ff',
  brightMagenta: '#caa9ff',
  brightCyan: '#9be8ff',
  brightWhite: '#ffffff',
} as const;

const AUTO_FALLBACK_BG = '#111111';
const AUTO_FALLBACK_FG = '#e5e7eb';
const AUTO_FALLBACK_ACCENT = '#7c9cff';

/**
 * Resolve the 'auto' palette from the document's CSS variables so the
 * terminal matches the surrounding app chrome in both light and dark mode.
 * Falls back to the dark defaults when no DOM is available (tests / SSR).
 */
export function resolveAutoTerminalTheme(): ITheme {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return {
      background: AUTO_FALLBACK_BG,
      foreground: AUTO_FALLBACK_FG,
      cursor: AUTO_FALLBACK_ACCENT,
      selectionBackground: 'rgba(124, 156, 255, 0.28)',
      ...AUTO_ANSI,
    };
  }
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--terminal-bg', AUTO_FALLBACK_BG),
    foreground: read('--text', AUTO_FALLBACK_FG),
    cursor: read('--accent', AUTO_FALLBACK_ACCENT),
    selectionBackground: 'rgba(124, 156, 255, 0.28)',
    ...AUTO_ANSI,
  };
}

const TOKYO_NIGHT: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: 'rgba(122, 162, 247, 0.32)',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ffcf7a',
  brightBlue: '#8db0ff',
  brightMagenta: '#caa9ff',
  brightCyan: '#9be8ff',
  brightWhite: '#ffffff',
};

const DRACULA: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(68, 71, 90, 0.8)',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

const NORD: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: 'rgba(136, 192, 208, 0.32)',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#d08770',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
};

const SOLARIZED_DARK: ITheme = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#93a1a1',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(38, 139, 210, 0.32)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

const GRUVBOX_DARK: ITheme = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: 'rgba(215, 153, 33, 0.32)',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
};

export const TERMINAL_THEME_PRESETS: TerminalThemePreset[] = [
  { id: 'auto', labelKey: 'terminal.themeAuto', swatch: ['#111111', '#e5e7eb', '#7c9cff'] },
  { id: 'tokyonight', labelKey: 'terminal.themeTokyoNight', swatch: ['#1a1b26', '#c0caf5', '#7aa2f7'], theme: TOKYO_NIGHT },
  { id: 'dracula', labelKey: 'terminal.themeDracula', swatch: ['#282a36', '#f8f8f2', '#bd93f9'], theme: DRACULA },
  { id: 'nord', labelKey: 'terminal.themeNord', swatch: ['#2e3440', '#d8dee9', '#88c0d0'], theme: NORD },
  { id: 'solarized', labelKey: 'terminal.themeSolarized', swatch: ['#002b36', '#839496', '#268bd2'], theme: SOLARIZED_DARK },
  { id: 'gruvbox', labelKey: 'terminal.themeGruvbox', swatch: ['#282828', '#ebdbb2', '#d79921'], theme: GRUVBOX_DARK },
];

/** Resolve any theme id to a concrete xterm palette. */
export function resolveTerminalTheme(id: TerminalThemeId): ITheme {
  const preset = TERMINAL_THEME_PRESETS.find((entry) => entry.id === id);
  if (preset?.theme) return preset.theme;
  return resolveAutoTerminalTheme();
}

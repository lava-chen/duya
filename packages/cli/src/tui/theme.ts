/**
 * Theme tokens for the TUI.
 *
 * ## Why themes exist as TOKENS and not colours
 *
 * Every colour the transcript paints used to be a literal blessed tag inside
 * `transcript-view.ts`. That works on a dark terminal and dissolves on a light
 * one — `{gray-fg}` on a white background is the worst offender. A token set
 * (`muted`, `accent`, `error`, …) with two palettes lets the renderer stay a
 * pure function while the palette behind it changes.
 *
 * ## Tag bodies, not tag strings
 *
 * A token maps to the tag BODY blessed expects between the braces
 * (`'gray-fg'`, `'241-fg'`), not to a wrapped string. The wrapper stays in
 * `transcript-view.ts`, which owns escaping. Bodies may be:
 *
 * - named colours (`gray-fg`, `bright-green-fg`) — the dark palette, which is
 *   byte-identical to what the renderer emitted before theming existed, so the
 *   existing markup tests are also the dark-palette tests;
 * - 256-colour numbers (`241-fg`) — the light palette. Verified against
 *   blessed's parser: `{241-fg}` renders as `\x1b[38;5;241m` (`element.js`
 *   `_parseTags` → `program._attr('241 fg')`). Hex tags were rejected: they
 *   quantise to the nearest 16-colour entry, which is not controllable.
 */

export type ThemeName = 'dark' | 'light';

/** The semantic colours the transcript is allowed to paint with. */
export type ThemeToken =
  | 'muted'
  | 'accent'
  | 'success'
  | 'error'
  | 'warning'
  | 'user'
  | 'thinking'
  | 'diffAdd'
  | 'diffDel'
  | 'heading'
  | 'link';

/** Token → blessed tag body (`'gray-fg'`, `'241-fg'`). */
export type ThemeTags = Readonly<Record<ThemeToken, string>>;

/**
 * Dark terminal palette — byte-identical to the pre-theme renderer.
 *
 * Kept hand-written (not derived) so a palette change here can never silently
 * move what the markup tests pin.
 */
export const DARK_THEME_TAGS: ThemeTags = {
  muted: 'gray-fg',
  accent: 'cyan-fg',
  success: 'bright-green-fg',
  error: 'bright-red-fg',
  warning: 'yellow-fg',
  user: 'bright-green-fg',
  thinking: 'magenta-fg',
  diffAdd: 'bright-green-fg',
  diffDel: 'red-fg',
  heading: 'cyan-fg',
  link: 'gray-fg',
};

/**
 * Light terminal palette, in 256-colour numbers.
 *
 * Chosen for contrast on white: dark green `28` for success, teal `30` for
 * accent, mid-grey `243` for muted text that `{gray-fg}` (bright black) would
 * make invisible.
 */
export const LIGHT_THEME_TAGS: ThemeTags = {
  muted: '243-fg',
  accent: '30-fg',
  success: '28-fg',
  error: '160-fg',
  warning: '172-fg',
  user: '28-fg',
  thinking: '128-fg',
  diffAdd: '28-fg',
  diffDel: '160-fg',
  heading: '30-fg',
  link: '243-fg',
};

const PALETTES: Readonly<Record<ThemeName, ThemeTags>> = {
  dark: DARK_THEME_TAGS,
  light: LIGHT_THEME_TAGS,
};

/** The theme used when nothing else is configured. */
export function defaultTheme(): ThemeName {
  return 'dark';
}

/**
 * Resolve the theme name from the environment.
 *
 * `DUYA_TUI_THEME` wins outright. Otherwise `COLORFGBG` (`fg;bg`) is read —
 * the one background hint Windows Terminal and most Linux setups publish
 * without a probe. A background of 0–6 means a dark terminal; anything else
 * (or no hint at all) keeps the dark default rather than guessing light,
 * because the dark palette is also what every test pins.
 */
export function resolveThemeName(env: NodeJS.ProcessEnv = process.env): ThemeName {
  const explicit = env['DUYA_TUI_THEME'];
  if (explicit === 'light' || explicit === 'dark') return explicit;

  const colorfgbg = env['COLORFGBG'];
  if (typeof colorfgbg === 'string') {
    const parts = colorfgbg.split(';');
    const bg = Number.parseInt(parts[parts.length - 1] ?? '', 10);
    if (Number.isInteger(bg)) return bg >= 0 && bg <= 6 ? 'dark' : 'light';
  }
  return defaultTheme();
}

/** The full theme (name + tags) for a name. */
export function themeFor(name: ThemeName): { readonly name: ThemeName; readonly tags: ThemeTags } {
  return { name, tags: PALETTES[name] };
}

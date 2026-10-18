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

/**
 * Reasoning effort, as the composer border paints it.
 *
 * ## Why the border carries this
 *
 * pi does it (`theme.getThinkingBorderColor`), and it is the one piece of state
 * that changes how expensive the NEXT message is without changing what the
 * conversation looks like. Putting it on the box the user is typing into means
 * "I am about to send this at max effort" is visible at the moment of typing,
 * not one screen away in a settings panel.
 *
 * ## The ramp
 *
 * A single hue path from desaturated slate to orange as effort rises, so the
 * levels read as a progression rather than as seven unrelated colours:
 * auto → minimal → low → medium (violet) → high (magenta) → xhigh (pink) →
 * max (orange). Values are 256-colour codes chosen against pi's own
 * `thinkingOff…thinkingMax` palette; `auto` is the muted grey the border used
 * to have, so "nothing selected" looks exactly as quiet as before.
 */
export type EffortLevel = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Levels in ascending order, for cycling and for the picker. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Border tag body per level, per palette. */
const EFFORT_BORDER_TAGS: Readonly<Record<ThemeName, Readonly<Record<EffortLevel, string>>>> = {
  dark: {
    auto: '240-fg',
    minimal: '67-fg',
    low: '68-fg',
    medium: '98-fg',
    high: '134-fg',
    xhigh: '205-fg',
    max: '208-fg',
  },
  light: {
    auto: '250-fg',
    minimal: '145-fg',
    low: '103-fg',
    medium: '104-fg',
    high: '170-fg',
    xhigh: '205-fg',
    max: '216-fg',
  },
};

/**
 * Blessed's own border colour names, for the full-screen composer.
 *
 * The blessed box takes a colour NAME or number, and the 256-colour numbers the
 * inline rules use do not survive its border path on every terminal. The
 * full-screen presentation is the legacy one, so it gets the nearest named
 * colour rather than a shared code path that renders wrong in one mode.
 */
const EFFORT_BORDER_NAMES: Readonly<Record<EffortLevel, string>> = {
  auto: 'grey',
  minimal: 'blue',
  low: 'cyan',
  medium: 'magenta',
  high: 'bright-magenta',
  xhigh: 'bright-red',
  max: 'yellow',
};

/** Human label, for the picker and the notice after a change. */
export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  auto: 'Auto (model default)',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Normalize whatever the Host or a caller says into a level.
 *
 * Unknown strings fall back to `auto` rather than throwing: effort arrives from
 * persisted settings and from run frames, and a value written by a newer build
 * must not take the TUI down. `'off'`/`'none'` mean auto for the same reason —
 * "no explicit effort" is exactly what auto is.
 */
export function normalizeEffort(value: string | null | undefined): EffortLevel {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'off' || normalized === 'none' || normalized === 'default') return 'auto';
  return (EFFORT_LEVELS as readonly string[]).includes(normalized) ? normalized as EffortLevel : 'auto';
}

/** Tag body for the composer rules/border at this effort. */
export function effortBorderTag(level: EffortLevel, theme: ThemeName): string {
  return EFFORT_BORDER_TAGS[theme][level];
}

/** Blessed border colour name for the full-screen composer at this effort. */
export function effortBorderColor(level: EffortLevel): string {
  return EFFORT_BORDER_NAMES[level];
}

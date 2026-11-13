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
 * - named colours (`gray-fg`, `bright-green-fg`) — the dark palette keeps its
 *   established semantic accents, while message text uses an explicit
 *   256-colour foreground so it does not inherit terminal-specific defaults;
 * - 256-colour numbers (`241-fg`) — the light palette. Verified against
 *   blessed's parser: `{241-fg}` renders as `\x1b[38;5;241m` (`element.js`
 *   `_parseTags` → `program._attr('241 fg')`). Hex tags were rejected: they
 *   quantise to the nearest 16-colour entry, which is not controllable.
 *
 * ## The two surfaces, and why they are fixed numbers
 *
 * codex fills the composer and the submitted prompts with a colour BLENDED
 * from the terminal's own background: 12% white over it in a dark terminal,
 * 4% black over it in a light one (`style.rs` `user_message_bg_rgb` /
 * `history_prompt_style`). That needs to know what the terminal background
 * actually is, and duya has no way to ask — the OSC 11 probe was rejected in
 * plan 611 W1.1, so the only hint is the `COLORFGBG` heuristic, which says
 * "dark" or "light" and nothing more.
 *
 * So the two fills are fixed 256-colour greys instead: `236` (`#303030`) behind
 * the composer and `238` (`#3c3c3c`) behind a submitted prompt in the dark
 * palette, `255` (`#eeeeee`) and `254` (`#e4e4e4`) in the light one. The
 * invariant that survives the approximation is the one that matters: a
 * submitted prompt is MORE prominent than the composer it replaces, in both
 * palettes — lighter on a dark terminal, darker on a light one.
 */

export type ThemeName = 'dark' | 'light';

/** The semantic colours the transcript is allowed to paint with. */
export type ThemeToken =
  | 'text'
  | 'muted'
  | 'accent'
  | 'success'
  | 'error'
  | 'toolErrorBg'
  | 'warning'
  | 'user'
  | 'thinking'
  | 'diffAdd'
  | 'diffDel'
  /**
   * The fills a diff row is painted with.
   *
   * `diffAddBg` / `diffDelBg` fill the sign-and-content part of a changed
   * row; `diffNumBgAdd` / `diffNumBgDel` fill the line-number chip beside it,
   * so the numbers read as a column of their own instead of competing with the
   * code's colours. `diffGutter` is the number's foreground, `diffHunk` the
   * `⋮` between hunks, and `diffHeader` the path of a multi-file change.
   *
   * They are BACKGROUNDS, like `promptBg`: the tag bodies
   * end in `-bg` and they fill the cell behind the text.
   *
   * The values are codex's own 256-colour fallbacks for its RGB diff fills
   * (`codex-rs/tui/src/diff_render.rs`): the exact RGB cannot be used because
   * this palette has no truecolor channel, and hex tags were rejected for the
   * reason above.
   */
  | 'diffAddBg'
  | 'diffDelBg'
  | 'diffNumBgAdd'
  | 'diffNumBgDel'
  | 'diffGutter'
  | 'diffHunk'
  | 'diffHeader'
  | 'heading'
  | 'link'
  | 'promptBg'
  /**
   * The fills behind transcript search matches.
   *
   * Like pi's `searchMatchBg` / `searchMatchCurrentBg`: every hit on a visible
   * line takes the first fill, the hit the cursor points at takes the second.
   * Both are BACKGROUNDS (`-bg` bodies) so the text colour underneath survives.
   * The yellow family is the convention search UIs share (vim, less, pi); the
   * light palette uses its pale end so dark text keeps its contrast. 256-colour
   * values for the same reason as the diff fills above — no truecolor channel,
   * and hex tags were rejected.
   */
  | 'searchMatchBg'
  | 'searchMatchCurrentBg';

/** Token → blessed tag body (`'gray-fg'`, `'241-fg'`). */
export type ThemeTags = Readonly<Record<ThemeToken, string>>;

/**
 * Dark terminal palette. Accents keep their established ANSI roles; message
 * text is explicit so its contrast does not depend on terminal defaults.
 */
export const DARK_THEME_TAGS: ThemeTags = {
  text: '254-fg',
  muted: 'gray-fg',
  accent: 'cyan-fg',
  success: 'bright-green-fg',
  error: 'bright-red-fg',
  toolErrorBg: '52-bg',
  warning: 'yellow-fg',
  user: 'bright-green-fg',
  thinking: 'magenta-fg',
  diffAdd: 'bright-green-fg',
  diffDel: 'red-fg',
  // codex's dark 256-colour fallbacks: 22 / 52 are its diff fills, 23 / 53
  // one step brighter for the line-number chips.
  diffAddBg: '22-bg',
  diffDelBg: '52-bg',
  diffNumBgAdd: '23-bg',
  diffNumBgDel: '53-bg',
  diffGutter: 'gray-fg',
  diffHunk: 'gray-fg',
  diffHeader: 'cyan-fg',
  heading: 'cyan-fg',
  link: 'gray-fg',
  promptBg: '238-bg',
  // Dark yellows: the hit is dim, the cursor's hit one step brighter.
  searchMatchBg: '58-bg',
  searchMatchCurrentBg: '100-bg',
};

/**
 * Light terminal palette, in 256-colour numbers.
 *
 * Chosen for contrast on white: dark green `28` for success, teal `30` for
 * accent, mid-grey `243` for muted text that `{gray-fg}` (bright black) would
 * make invisible.
 */
export const LIGHT_THEME_TAGS: ThemeTags = {
  text: '238-fg',
  muted: '243-fg',
  accent: '30-fg',
  success: '28-fg',
  error: '160-fg',
  toolErrorBg: '224-bg',
  warning: '172-fg',
  user: '28-fg',
  thinking: '128-fg',
  diffAdd: '28-fg',
  diffDel: '160-fg',
  // codex's light 256-colour fallbacks: 194 / 224 are its diff fills, 157 /
  // 217 the line-number chips.
  diffAddBg: '194-bg',
  diffDelBg: '224-bg',
  diffNumBgAdd: '157-bg',
  diffNumBgDel: '217-bg',
  diffGutter: '236-fg',
  diffHunk: '244-fg',
  diffHeader: '30-fg',
  heading: '30-fg',
  link: '243-fg',
  promptBg: '254-bg',
  // Pale cream and sand: readable under dark text, distinct from the
  // greenish/rose diff fills (194/224).
  searchMatchBg: '229-bg',
  searchMatchCurrentBg: '186-bg',
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

/**
 * Wrap text in a theme token's colour.
 *
 * The renderer vocabulary is the same blessed-style tag pair everywhere, so a
 * token can be applied from anywhere that holds a palette — the footer, the
 * composer border, the status line — without each call site rebuilding the
 * braces.
 */
export function taggedWith(tags: ThemeTags, token: ThemeToken, text: string): string {
  const tag = tags[token];
  return `{${tag}}${text}{/${tag}}`;
}

/** Blessed border colour name for the full-screen composer at this effort. */
export function effortBorderColor(level: EffortLevel): string {
  return EFFORT_BORDER_NAMES[level];
}

/**
 * What the terminal can actually do.
 *
 * ## Why this is a function and not a probe
 *
 * The TUI used to answer "how many colours does this terminal have?" with a
 * constant (`colors: 256`) and "does it draw box characters?" with another
 * (`fullUnicode: true`). Both are claims, not measurements, and a claim the
 * terminal cannot honour is not cosmetic:
 *
 * - the LIGHT palette in `theme.ts` is expressed entirely in 256-colour
 *   numbers (`241-fg`, `30-fg`). On a 16-colour terminal those quantise to
 *   whatever is nearest, so "light theme" turns into unreadable text;
 * - `TERM` unset was papered over with `'xterm-256color'`, which tells
 *   blessed the truth is 256 colours when the truth may be eight.
 *
 * There is no reliable way to ASK a terminal what it supports — there is no
 * query that every terminal answers correctly — so the honest source is what
 * the terminal already publishes about itself in the environment. Every
 * modern emulator sets at least one of these, and every check below is a
 * named variable with a known meaning.
 *
 * ## Why it takes env as an argument
 *
 * Detection must be a pure function of its inputs. A probe that reads
 * `process.env` directly can only be tested by mutating global state, which is
 * how "works on my machine" detection bugs get in. Passing the bag in also
 * makes the awkward cases — `TERM=dumb`, Windows without `WT_SESSION`, a
 * UTF-8 locale under a terminal that still cannot draw boxes — expressible as
 * ordinary table-driven tests instead of as a real terminal.
 *
 * `platform` is a second input for the same reason: the Windows row of
 * `detectUnicodeBox` is not reachable from an environment bag alone, because
 * what identifies it is an ABSENCE of variables. See that function.
 */

/** How much colour the terminal can address. */
export type ColorDepth = 16 | 256 | 'truecolor';

/** Terminals we can name, because being able to name one unlocks behaviour. */
export type TerminalProgram =
  | 'windows-terminal'
  | 'vscode'
  | 'iterm2'
  | 'wezterm'
  | 'kitty'
  | 'alacritty'
  | 'apple-terminal'
  | 'tmux'
  | 'unknown';

export interface TerminalEnvironment {
  /** Value to hand blessed's `program({ terminal })`. Never a guess. */
  readonly term: string;
  readonly program: TerminalProgram;
  readonly colorDepth: ColorDepth;
  /** Whether box-drawing and CJK-safe glyphs can be trusted. */
  readonly unicodeBox: boolean;
  /** OSC 8 hyperlinks. */
  readonly hyperlinks: boolean;
  /** Kitty/iTerm inline image protocol, for future attachment previews. */
  readonly kittyGraphics: boolean;
  /**
   * Whether the LIGHT palette can render here at all. That palette is written
   * entirely in 256-colour numbers, so on a 16-colour terminal the answer is
   * no and a light theme has to fall back rather than emit tags the terminal
   * will quantise into noise.
   */
  readonly supportsLightPalette: boolean;
}

/** Terminals known to handle UTF-8 box drawing correctly. */
const UNICODE_CAPABLE: ReadonlySet<TerminalProgram> = new Set([
  'windows-terminal',
  'vscode',
  'iterm2',
  'wezterm',
  'kitty',
  'alacritty',
  'apple-terminal',
]);

function detectProgram(env: NodeJS.ProcessEnv): TerminalProgram {
  // WT_SESSION is Windows Terminal's own claim, and it is set on every child
  // process including the ones this CLI spawns.
  if (typeof env['WT_SESSION'] === 'string' && env['WT_SESSION'] !== '') return 'windows-terminal';

  const termProgram = env['TERM_PROGRAM'] ?? '';
  switch (termProgram) {
    case 'vscode':
    case 'Hyper':
      return 'vscode';
    case 'iTerm.app':
      return 'iterm2';
    case 'WezTerm':
      return 'wezterm';
    case 'Apple_Terminal':
      return 'apple-terminal';
    case 'Alacritty':
      return 'alacritty';
    default:
      break;
  }

  const term = env['TERM'] ?? '';
  if (term === 'xterm-kitty') return 'kitty';
  if (term.startsWith('tmux') || term.startsWith('screen') || env['TMUX'] !== undefined) return 'tmux';
  return 'unknown';
}

function detectColorDepth(env: NodeJS.ProcessEnv, program: TerminalProgram): ColorDepth {
  const colorTerm = (env['COLORTERM'] ?? '').toLowerCase();
  // COLORTERM is the only broadly-honoured 24-bit hint. `truecolor` and
  // `24bit` are the two spellings in the wild.
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor';

  // Windows Terminal is 24-bit capable and does not always publish COLORTERM
  // to child processes, so its own session variable is the honest signal.
  if (program === 'windows-terminal') return 'truecolor';

  const term = env['TERM'] ?? '';
  if (term === '') return 16;
  if (term === 'dumb') return 16;
  return term.includes('256color') ? 256 : 16;
}

/**
 * Whether box-drawing glyphs can be trusted.
 *
 * The Linux virtual console is the case that bites: it advertises a normal
 * `xterm` TERM but mangles box characters depending on the console font, so a
 * UTF-8 locale is not enough to say yes.
 *
 * ## The Windows row, and why it needs `platform`
 *
 * This check used to end at `isUtf8Locale`, which reads `LC_ALL` / `LC_CTYPE` /
 * `LANG`. Those are POSIX variables: a stock Windows PowerShell or cmd window
 * sets none of them, not even to a non-UTF-8 value. So the probe read "no
 * variable" as "this console cannot do UTF-8" and returned `unicodeBox: false`
 * for every Windows user outside Windows Terminal -- which blessed then honours
 * by replacing every non-ASCII cell with `?`. Measured, not inferred: a blessed
 * box whose content is `你好` writes `<ESC>[1;1H?` with `fullUnicode: false`,
 * while `box.content` still reads `"你好"`. Every CJK character in the
 * transcript AND in the composer was lost, while the input side still received
 * the characters correctly -- which is what made it look like a terminal
 * encoding problem rather than a render-mode one.
 *
 * Node writes UTF-8 to stdout on Windows regardless of the console's OEM code
 * page, and the Windows-side consoles in use (Windows Terminal, conhost since
 * 1903, VS Code, mintty) all render it. So on win32 the answer is yes unless
 * something says otherwise explicitly, which is what `DUYA_TUI_ASCII` is for.
 */
function detectUnicodeBox(
  env: NodeJS.ProcessEnv,
  program: TerminalProgram,
  platform: NodeJS.Platform,
): boolean {
  // The escape hatch, checked first so it overrides even a capable terminal.
  if (env['DUYA_TUI_ASCII'] === '1') return false;
  const term = (env['TERM'] ?? '').toLowerCase();
  if (term === 'dumb') return false;
  if (term === 'linux') return false;
  if (UNICODE_CAPABLE.has(program)) return true;
  if (platform === 'win32') return true;
  // tmux inherits the outer terminal's abilities; if we got here the outer one
  // was not a name we recognise, so require an explicit UTF-8 locale.
  return isUtf8Locale(env);
}

function isUtf8Locale(env: NodeJS.ProcessEnv): boolean {
  for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG'] as const) {
    const value = env[key];
    if (typeof value === 'string' && /utf-?8/i.test(value)) return true;
  }
  return false;
}

/**
 * Read the terminal's self-description out of an environment bag.
 *
 * `platform` is an explicit input rather than a `process.platform` read so the
 * Windows row of `detectUnicodeBox` is reachable from a test instead of only on
 * the one machine it was found on.
 */
export function detectTerminalEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalEnvironment {
  const program = detectProgram(env);
  const colorDepth = detectColorDepth(env, program);
  const unicodeBox = detectUnicodeBox(env, program, platform);
  const term = env['TERM'] ?? '';
  const dumb = term === 'dumb';

  return {
    // blessed matches on this string; an empty TERM is passed through as an
    // empty string rather than being upgraded to a capability we cannot prove.
    term: term === '' ? 'dumb' : term,
    program,
    colorDepth,
    unicodeBox,
    // OSC 8 needs a terminal that is not in a degraded mode. Every named
    // emulator implements it; `unknown` does not get the benefit of the doubt,
    // because a literal `]8;;url` showing in the transcript is worse than a
    // plain URL.
    hyperlinks: !dumb && program !== 'unknown',
    kittyGraphics: program === 'kitty' || program === 'wezterm' || program === 'iterm2',
    // The light palette is 256-colour only, so it cannot be honoured below 256.
    supportsLightPalette: colorDepth !== 16,
  };
}

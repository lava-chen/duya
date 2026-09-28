/**
 * cua/keys.ts — key chord normalization.
 *
 * Ported from the ZCode SDK key-alias table (plan 575): agents learn
 * xdotool / X keysym spellings on other harnesses, so the input side
 * accepts both those and duya's native token set. Only input-side
 * compatibility — the cross-platform modifier rule (macOS cmd, Windows
 * / Linux ctrl) is the caller's concern.
 */

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  return: 'return',
  enter: 'return',
  kp_enter: 'return',
  control_l: 'ctrl',
  control_r: 'ctrl',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt_l: 'alt',
  alt_r: 'alt',
  meta_l: 'alt',
  alt: 'alt',
  shift_l: 'shift',
  shift_r: 'shift',
  shift: 'shift',
  escape: 'esc',
  esc: 'esc',
  prior: 'pageup',
  next: 'pagedown',
  period: '.',
  comma: ',',
  greater: '>',
  slash: '/',
  minus: '-',
  equal: '=',
});

/**
 * Normalize one chord ("Control_L+a", "super+c", "Return") into duya's
 * token set. `platform` decides what `super` becomes.
 */
export function normalizeKeyChord(
  chord: string,
  platform: 'darwin' | 'win32' | 'linux' = process.platform as 'darwin' | 'win32' | 'linux',
): string {
  return chord
    .split('+')
    .map((raw) => {
      const token = raw.trim();
      const lower = token.toLowerCase();
      if (lower === 'super_l' || lower === 'super_r' || lower === 'super') {
        return platform === 'darwin' ? 'cmd' : platform === 'win32' ? 'win' : 'super';
      }
      return KEY_ALIASES[lower] ?? token;
    })
    .filter(Boolean)
    .join('+');
}

/** Split a normalized chord into modifiers + main key ("ctrl+shift+a"). */
export function splitChord(normalized: string): {
  modifiers: string[];
  key: string;
} {
  const parts = normalized.split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  return { modifiers: parts, key };
}

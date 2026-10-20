/**
 * expressions/pathTween.ts — minimal SVG path string interpolator.
 *
 * Bloub does path morphing in pure TypeScript (no library) using
 * its own `shape.ts` helpers. We need the same capability at a
 * smaller scale: cross-fade between two mouth paths during
 * state transitions.
 *
 * Approach:
 *   1. Tokenize the path `d` into commands (M / L / Q / Z).
 *   2. When the two paths share the same command sequence,
 *      interpolate the numeric arguments frame by frame.
 *   3. When they differ, return both paths and a `crossFade`
 *      opacity pair so the renderer can blend them.
 *
 * Why not a full SVG path morph library? Because we only need it
 * for the mouth (5 shapes total) and the duya expressions are
 * designed to share command sequences across the most common
 * transitions (smile <-> focused uses both `smile` shape with
 * different `Q` control points).
 *
 * The implementation is intentionally small (~80 LoC) so the
 * tween's behavior is auditable. If we need it for the body shape
 * later (radial profile morphing, like bloub), we'll add a
 * second helper.
 */

export interface TweenedPath {
  /**
   * The single path string to render this frame, or `null` when
   * the caller should cross-fade both source paths (returned
   * alongside).
   */
  d: string | null;
  /** Source A opacity (0..1) when cross-fading. */
  opacityA: number;
  /** Source B opacity (0..1) when cross-fading. */
  opacityB: number;
}

interface Command {
  type: 'M' | 'L' | 'Q' | 'Z';
  /** Numeric arguments in source order. Z has zero. */
  args: number[];
}

const COMMAND_CHARS = new Set(['M', 'L', 'Q', 'Z']);

/**
 * Tokenize an SVG path `d` into commands. SVG convention: each
 * command letter starts a new command, and the numeric args
 * continue until the next command letter. Whitespace and commas
 * are both valid separators between numbers.
 */
export function tokenize(d: string): Command[] {
  const out: Command[] = [];
  if (!d) return out;
  // Normalize separators and walk the string with a small state
  // machine. We support both whitespace- and comma-separated
  // forms (e.g. "M 0 0 L 10 10" and "M0,0 L10,10" both work).
  const normalized = d.replace(/,/g, ' ').replace(/([MLQZmlqz])/g, ' $1 ');
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);

  let current: Command | null = null;
  for (const tok of tokens) {
    const first = tok[0];
    if (COMMAND_CHARS.has(first)) {
      if (current) out.push(current);
      if (first === 'Z' || first === 'z') {
        // Z closes the path; our mouths are open paths so we
        // skip rather than emit a no-op entry (keeps the
        // sameShape check honest).
        current = null;
        continue;
      }
      current = { type: first as Command['type'], args: [] };
    } else {
      // Number token — append to the current command.
      if (!current) continue;
      const n = Number.parseFloat(tok);
      if (Number.isFinite(n)) {
        current.args.push(n);
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function sameShape(a: Command[], b: Command[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (a[i].args.length !== b[i].args.length) return false;
  }
  return true;
}

/**
 * Interpolate between two paths at progress t in [0, 1].
 *
 * Same command sequence: linearly interpolate the numeric args
 * and rebuild the path string.
 *
 * Different command sequences: return `d: null` and
 * `opacityA = 1 - t, opacityB = t` so the caller cross-fades
 * (each source path rendered with its own opacity).
 */
export function tweenPath(
  fromD: string,
  toD: string,
  t: number,
): TweenedPath {
  if (fromD === toD) {
    return { d: toD, opacityA: 1, opacityB: 1 };
  }

  // Decide interpolation strategy up front so endpoint handling
  // is consistent for both linear-interp and cross-fade.
  const fromCmds = tokenize(fromD);
  const toCmds = tokenize(toD);
  const canLinear = sameShape(fromCmds, toCmds) && fromCmds.length > 0 && toCmds.length > 0;

  if (t <= 0) {
    if (canLinear) {
      return { d: fromD, opacityA: 1, opacityB: 0 };
    }
    return { d: null, opacityA: 1, opacityB: 0 };
  }
  if (t >= 1) {
    if (canLinear) {
      return { d: toD, opacityA: 0, opacityB: 1 };
    }
    return { d: null, opacityA: 0, opacityB: 1 };
  }

  if (fromCmds.length === 0 && toCmds.length === 0) {
    return { d: '', opacityA: 1, opacityB: 1 };
  }
  if (fromCmds.length === 0) {
    return { d: null, opacityA: 0, opacityB: 1 };
  }
  if (toCmds.length === 0) {
    return { d: null, opacityA: 1, opacityB: 0 };
  }

  if (!canLinear) {
    return { d: null, opacityA: 1 - t, opacityB: t };
  }

  // Same shape — interpolate arg by arg.
  const parts: string[] = [];
  for (let i = 0; i < fromCmds.length; i++) {
    const f = fromCmds[i];
    const to = toCmds[i];
    parts.push(f.type);
    for (let j = 0; j < f.args.length; j++) {
      const v = f.args[j] + (to.args[j] - f.args[j]) * t;
      // Drop trailing zeros for cleaner output.
      parts.push(Number.isInteger(v) ? v.toString() : v.toFixed(2).replace(/\.?0+$/, ''));
    }
  }
  return { d: parts.join(' '), opacityA: 1, opacityB: 0 };
}

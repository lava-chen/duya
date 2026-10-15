/**
 * TTY detection, and the guard that decides whether a TUI may be built at all.
 *
 * ## Why this is a correctness requirement and not polish
 *
 * `blessed.screen()` claims the terminal the moment it is constructed. Measured
 * on this repo's blessed 0.1.81, constructing one with stdout piped to another
 * process writes `ESC[1;1H ESC[H ESC[J ESC[H ESC[J` into that pipe — cursor
 * positioning and erase-screen sequences injected ahead of the real output.
 *
 * Blessed does skip the alternate-screen switch (`?1049`) when stdout is not a
 * TTY, so the damage is bounded, but it is not zero, and for `--print` piped
 * into a file or another program those bytes are corruption of the result.
 *
 * So the decision is made at STARTUP, before any widget exists, and a
 * non-interactive process never constructs the TUI at all — it falls through
 * to the existing readline REPL, which already handles terminal readline,
 * persisted history and tab completion.
 */

export interface TtyStreams {
  readonly stdin: { isTTY?: boolean } | null;
  readonly stdout: { isTTY?: boolean } | null;
}

/** The live process streams. Overridable so tests can drive the decision. */
export function processStreams(): TtyStreams {
  return { stdin: process.stdin, stdout: process.stdout };
}

/**
 * True only when BOTH ends are a terminal.
 *
 * Both, not either. A TUI needs a terminal to draw on and a terminal to read
 * keys from; stdin redirected from a file with stdout on a terminal is a case
 * where the first is missing, and stdout piped with stdin on a terminal is
 * where the second is.
 */
export function isInteractiveTty(streams: TtyStreams = processStreams()): boolean {
  return streams.stdin?.isTTY === true && streams.stdout?.isTTY === true;
}

/**
 * True when a full-screen TUI should be built.
 *
 * `DUYA_CLI_TUI=0` forces the plain REPL, which is the escape hatch for
 * anyone whose terminal misbehaves under the alternate screen — and the only
 * way to compare the two surfaces without changing code.
 */
export function shouldUseTui(
  streams: TtyStreams = processStreams(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.DUYA_CLI_TUI === '0') return false;
  return isInteractiveTty(streams);
}

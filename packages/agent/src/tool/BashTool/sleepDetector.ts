/**
 * Detect standalone or leading `sleep N` patterns that should not be
 * allowed - the model should use `run_in_background: true` instead.
 *
 * Catches `sleep 5`, `sleep 5 && check`, `sleep 5; check` - but not
 * sleep inside pipelines, subshells, or scripts.
 *
 * Returns a human-readable reason string, or null if the pattern is OK.
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  // Match: sleep <number> [rest...] at the start of the command.
  // Number can be integer or decimal.
  const m = /^sleep\s+(\d+(?:\.\d+)?)\s*(.*)$/.exec(trimmed);
  if (!m) return null;

  const secs = parseFloat(m[1]!);
  if (secs < 2) return null;

  let rest = m[2]!.trim();
  // Strip leading command separators (&&, ;, ||, &) so the "followed by"
  // description only shows the next command, not the separator.
  rest = rest.replace(/^(?:&&|\|\||;|&)\s*/, '');

  const secsStr = Number.isInteger(secs) ? String(secs) : m[1]!;

  return rest ? `sleep ${secsStr} followed by: ${rest}` : `standalone sleep ${secsStr}`;
}

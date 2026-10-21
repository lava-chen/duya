/**
 * agent-id.ts — Bot agent id validation (Plan 485, Phase 1).
 *
 * Bot ids are human-readable kebab-case slugs (`frontend-expert`) that are
 * ALSO used as directory names under `~/.duya/agents/<id>`. Validation is
 * therefore a security boundary: an id with separators, dots, `..`, or
 * surrounding whitespace could escape the agents root when joined into a
 * path. Mirrors grok's `isSafeFolderId` + 485's stricter kebab rule.
 *
 * Format: `^[a-z0-9][a-z0-9-]{0,62}$`
 *   - starts with lowercase letter or digit
 *   - followed by up to 62 lowercase letters / digits / dashes
 *   - no uppercase, underscore, dot, slash, backslash, whitespace, or `..`
 */

/** Regex is the single source of truth for a legal bot id. */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Type guard: true when `id` is a legal bot id. */
export function isSafeBotId(id: unknown): id is string {
  return typeof id === 'string' && BOT_ID_PATTERN.test(id);
}

/** Throws when `id` is not a legal bot id (path-safety boundary). */
export function assertValidBotId(id: string): void {
  if (!isSafeBotId(id)) {
    throw new Error(
      `Invalid bot id '${id}': must match ${BOT_ID_PATTERN} (kebab-case, starts with a lowercase letter or digit, max 63 chars)`,
    );
  }
}

/**
 * Existing-config id scanner: report (do not throw) when a config.toml
 * `[agents.<id>]` key is not a legal bot id. Plan 485 Phase 1 only warns —
 * migration tooling (Phase 4) handles renaming. Returns the offending keys.
 */
export function findInvalidBotIds(ids: Iterable<unknown>): string[] {
  const bad: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !isSafeBotId(id)) {
      bad.push(String(id));
    }
  }
  return bad;
}

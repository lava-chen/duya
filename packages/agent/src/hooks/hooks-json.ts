/**
 * hook.json file loader (plan 87 config rework).
 *
 * The `[hooks]` section of `~/.duya/config.toml` only records the paths of
 * user hook files; this module parses one hook.json file into the internal
 * {@link HooksSettings} shape. The file format is the de-facto ecosystem
 * shape shared by Claude Code's `settings.json` `hooks` field and ZCode
 * plugin `hooks.json` files:
 *
 * ```json
 * {
 *   "description": "Optional human-readable note (ignored)",
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Edit|Write|MultiEdit",
 *         "hooks": [
 *           { "type": "process", "command": "node", "args": ["scan.mjs"], "timeoutMs": 120000 }
 *         ]
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * No conversion is needed: the `hooks` object IS the plan-87
 * `HooksSettingsSchema` shape (event → matcher groups → hook commands), so
 * a hook file written for Claude Code / ZCode loads into duya unchanged
 * (same matcher semantics: bare regex against the tool name — see
 * `matcherAppliesToTool` in ./events.ts).
 *
 * Fail-open contract mirrors the config reader: a missing file, invalid
 * JSON, or schema violation logs WARN and contributes nothing — a broken
 * hook file must never break the agent loop.
 */

import { HooksSettingsSchema, type HooksSettings } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Parse one hook.json file body into {@link HooksSettings}.
 *
 * Accepts the ecosystem shape (`{ description?, hooks: { ... } }`). The
 * top-level `description` field is tolerated and ignored; unknown keys
 * inside `hooks` (event typos) fail the strict schema so misconfiguration
 * surfaces as a WARN instead of silently never firing.
 *
 * Returns undefined (after logging) when the content is not JSON, lacks a
 * `hooks` object, or fails schema validation.
 */
export function parseHooksJsonContent(
  raw: string,
  sourceLabel: string,
): HooksSettings | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[HooksConfig] ${sourceLabel} is not valid JSON (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    logger.warn(`[HooksConfig] ${sourceLabel} must be a JSON object (ignored)`);
    return undefined;
  }
  const hooks = (doc as { hooks?: unknown }).hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    logger.warn(`[HooksConfig] ${sourceLabel} has no "hooks" object (ignored)`);
    return undefined;
  }
  try {
    return HooksSettingsSchema.strict().parse(hooks);
  } catch (err) {
    logger.warn(
      `[HooksConfig] invalid "hooks" in ${sourceLabel} (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Merge several hook-file settings into one. Same-event matcher groups are
 * concatenated in file order — every file's hooks for an event all fire, in
 * the order the files appear in `[hooks] files`.
 */
export function mergeHooksSettings(
  parts: Array<HooksSettings | undefined>,
): HooksSettings | undefined {
  const merged: HooksSettings = {};
  let any = false;
  for (const part of parts) {
    if (!part) continue;
    if (Object.keys(part).length === 0) continue; // empty hooks object
    any = true;
    for (const [event, matchers] of Object.entries(part)) {
      const existing = merged[event as keyof HooksSettings];
      merged[event as keyof HooksSettings] = existing ? [...existing, ...matchers] : matchers;
    }
  }
  return any ? merged : undefined;
}

/**
 * bot-profile.ts — Bot identity source read/write (Host fs half).
 *
 * `profile.json` under `<duyaRoot>/agents/<id>/` is the *runtime* identity
 * source: model self-edits (`update_state`) and UI changes land here, NOT in
 * config.toml. config.toml `[agents.<id>]` name/description seed this file on
 * first creation and act only as a display fallback when the profile is
 * missing.
 *
 * The profile SHAPES and the schema-version constant moved to `@duya/bot`
 * (framework plan S2); this module keeps the fs half — atomic writes (tmp +
 * rename in the same directory, so a fs.watch consumer never observes a
 * half-written file) — and re-exports the shapes for the config-agents
 * barrel.
 *
 * Field semantics:
 *   - name         — display identity; the model may change it
 *   - title        — display subtitle / role line (UI/host-managed only)
 *   - description  — one-line role; the model may change it
 *   - avatarColor  — optional color token for the animated agent face body.
 *                    Legacy avatarEmoji/avatarImage keys in old files are
 *                    simply dropped on the next write.
 *   - schemaVersion — reserved for migrations; `migrate` hook fires when a
 *                     file with a newer/older version is read
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOT_PROFILE_SCHEMA_VERSION } from '@duya/bot';
import type { BotProfile, BotProfileInput } from '@duya/bot';

export { BOT_PROFILE_SCHEMA_VERSION };
export type { BotProfile, BotProfileInput };

export const BOT_PROFILE_FILENAME = 'profile.json';

/** Hook invoked when an existing file declares a different schemaVersion. */
export type ProfileMigrationHook = (
  profile: BotProfile,
  filePath: string,
) => BotProfile;

/** Default migration: identity — unknown versions are left as-is. */
const NOOP_MIGRATION: ProfileMigrationHook = (profile) => profile;

function parseProfileJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Read a bot profile from disk. Missing/corrupt file → null (the caller
 * decides fallback — config.toml name/description). When the stored
 * schemaVersion differs from the current one, `migrate` (default identity) is
 * applied and the migrated profile returned in-memory; callers that want the
 * migration persisted must write it back.
 */
export function readBotProfile(
  filePath: string,
  migrate: ProfileMigrationHook = NOOP_MIGRATION,
): BotProfile | null {
  const parsed = parseProfileJson(filePath);
  if (parsed === null) return null;

  const profile: BotProfile = {
    schemaVersion:
      typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : BOT_PROFILE_SCHEMA_VERSION,
    name: str(parsed.name),
    title: str(parsed.title).trim(),
    description: str(parsed.description),
    avatarColor: str(parsed.avatarColor).trim() || undefined,
  };

  if (profile.schemaVersion !== BOT_PROFILE_SCHEMA_VERSION) {
    return migrate(profile, filePath);
  }
  return profile;
}

/** Serialize + write atomically (tmp + rename). Ensures the parent dir exists. */
export function writeBotProfile(filePath: string, profile: BotProfileInput): BotProfile {
  const normalized: BotProfile = {
    schemaVersion: profile.schemaVersion ?? BOT_PROFILE_SCHEMA_VERSION,
    name: profile.name,
    title: profile.title?.trim() ?? '',
    description: profile.description,
    avatarColor: profile.avatarColor?.trim() || undefined,
  };

  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, filePath);
  return normalized;
}

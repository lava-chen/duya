/**
 * bot-profile.ts — Bot identity source read/write (Plan 485, Phase 1).
 *
 * `profile.json` under `~/.duya/agents/<id>/` is the *runtime* identity
 * source (Plan 485 §2.4): model self-edits (update_state, Plan 481) and
 * UI changes land here, NOT in config.toml. config.toml `[agents.<id>]`
 * name/description seed this file on first creation and act only as a
 * display fallback when the profile is missing.
 *
 * Semantics (aligned with grok `agent-profile.ts` + 485 decisions):
 *   - name         — display identity; the model may change it (update_state)
 *   - title        — display subtitle / role line. UI/roster metadata; the
 *                    model does NOT change title directly (485 §2.4)
 *   - description  — one-line role; the model may change it
 *   - avatarColor   — optional color token (colored initial-circle avatar)
 *   - avatarImage   — optional avatar image filename inside the agent dir
 *                     (e.g. `avatar.png`); supersedes the removed geometric
 *                     avatarShape field, which legacy files may still carry
 *                     (ignored on read)
 *   - schemaVersion — reserved for migrations; `migrate` hook fires when a
 *                     file with a newer/older version is read
 *
 * Writes are atomic: tmp file + rename in the same directory, so a
 * fs.watch consumer (Plan 483 roster) never observes a half-written file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const BOT_PROFILE_SCHEMA_VERSION = 1;
export const BOT_PROFILE_FILENAME = 'profile.json';

export interface BotProfile {
  schemaVersion: number;
  /** Display identity name (model-updatable via update_state). */
  name: string;
  /** Display subtitle / role title (UI/host-managed only). */
  title: string;
  /** One-line role description (model-updatable via update_state). */
  description: string;
  /** Optional color token for the colored initial-circle avatar. */
  avatarColor?: string;
  /**
   * Optional avatar image filename inside the agent directory
   * (`avatar.png` etc., validated against the whitelist in bot-avatar.ts).
   * When present it renders instead of the color circle.
   */
  avatarImage?: string;
}

/** Input accepted from callers (update_state / UI); defaults applied on write. */
export type BotProfileInput = Omit<BotProfile, 'schemaVersion'> &
  Partial<Pick<BotProfile, 'schemaVersion'>>;

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
 * decides fallback — config.toml name/description per 485 §2.4). When the
 * stored schemaVersion differs from the current one, `migrate` (default
 * identity) is applied and the migrated profile returned in-memory; callers
 * that want the migration persisted must write it back.
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
    avatarEmoji: str(parsed.avatarEmoji).trim() || undefined,
    avatarImage: str(parsed.avatarImage).trim() || undefined,
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
    avatarImage: profile.avatarImage?.trim() || undefined,
    avatarEmoji: profile.avatarEmoji?.trim() || undefined,
  };

  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, filePath);
  return normalized;
}

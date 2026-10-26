/**
 * profile.ts — the pure Bot runtime-identity shapes (framework plan S2).
 *
 * `profile.json` under `<duyaRoot>/agents/<id>/` is the *runtime* identity
 * source: model self-edits (`update_state`) and UI changes land here, NOT in
 * config.toml. config.toml `[agents.<id>]` name/description seed this file on
 * first creation and act only as a display fallback when the profile is
 * missing.
 *
 * Only the TYPES and the schema-version constant live here. The fs functions
 * (`readBotProfile` / `writeBotProfile`) are Host adapters — the domain
 * package performs no IO — and they consume these shapes.
 *
 * Field semantics:
 *   - name         — display identity; the model may change it
 *   - title        — display subtitle / role line (UI/host-managed only)
 *   - description  — one-line role; the model may change it
 *   - avatarColor  — optional color token for the animated agent face body.
 *                    Legacy avatarEmoji/avatarImage keys in old files are
 *                    simply dropped on the next write.
 *   - schemaVersion — reserved for migrations; a `migrate` hook fires when a
 *                     file with a newer/older version is read
 */

export const BOT_PROFILE_SCHEMA_VERSION = 1;

export interface BotProfile {
  schemaVersion: number;
  /** Display identity name (model-updatable via update_state). */
  name: string;
  /** Display subtitle / role title (UI/host-managed only). */
  title: string;
  /** One-line role description (model-updatable via update_state). */
  description: string;
  /** Optional color token for the animated agent face body. */
  avatarColor?: string | undefined;
}

/** Input accepted from callers (update_state / UI); defaults applied on write. */
export type BotProfileInput = Omit<BotProfile, 'schemaVersion'> &
  Partial<Pick<BotProfile, 'schemaVersion'>>;

/**
 * bot-profile.ts — Bot identity source read/write.
 *
 * `profile.json` under `<duyaRoot>/agents/<id>/` is the *runtime* identity
 * source: model self-edits (update_state) and UI changes land here, NOT in
 * config.toml. The implementation lives in `@duya/host/config-agents` so the
 * Desktop and the standalone Host write the same file in the same way.
 */

export {
  BOT_PROFILE_FILENAME,
  BOT_PROFILE_SCHEMA_VERSION,
  readBotProfile,
  writeBotProfile,
} from '@duya/host/config-agents';
export type {
  BotProfile,
  BotProfileInput,
  ProfileMigrationHook,
} from '@duya/host/config-agents';

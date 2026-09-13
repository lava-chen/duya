/**
 * agent-paths.ts — Bot storage path derivation (Plan 485, Phase 1).
 *
 * Single source of truth for `~/.duya/agents/` path construction. No other
 * module may join agent paths by hand — every consumer goes through the
 * helpers below so the directory layout stays consistent and safe.
 *
 * Layout (Plan 485 §2.2):
 *   <duyaRoot>/agents/<agentId>/profile.json   — runtime identity source
 *   <duyaRoot>/agents/<agentId>/settings.json  — mutable settings (host)
 *   <duyaRoot>/agents/<agentId>/avatar.<ext>   — avatar file
 *   <duyaRoot>/agents/<agentId>/state/         — reserved (476/477/484)
 *   <duyaRoot>/agents/<agentId>/memory/        — reserved (479)
 *
 * The duya root comes from `resolveConfigRoot()` (compass.ts) so tests
 * running under `--duya-namespace` and the DUYA_TEST env get an isolated
 * tree automatically, mirroring how config.toml is resolved.
 */

import path from 'path';
import { resolveConfigRoot } from './compass.js';
import { assertValidBotId } from './agent-id.js';
import { isValidAvatarImageFilename } from './bot-avatar.js';
import { getConfigStore } from './store-instance';

/** `~/.duya/agents` — root of all bot identity directories. */
export function getDuyaAgentsRoot(duyaRoot: string = resolveConfigRoot()): string {
  return path.join(duyaRoot, 'agents');
}

/**
 * `~/.duya/agents` resolved through the ConfigStore singleton, so dev and
 * packaged installs share one tree and tests that inject a temp store via
 * `_setConfigStoreForTest` get an isolated one automatically (plan 526).
 */
export function getSharedAgentsRoot(): string {
  return getDuyaAgentsRoot(getConfigStore().getConfigDir());
}

/**
 * Resolve `<duyaRoot>/agents/<agentId>`. Asserts a safe bot id first so a
 * hostile/typo id can never escape the agents root (no separators, no `..`,
 * kebab-case only — see agent-id.ts).
 */
export function resolveDuyaAgentDir(agentId: string, duyaRoot?: string): string {
  assertValidBotId(agentId);
  return path.join(getDuyaAgentsRoot(duyaRoot), agentId);
}

/** `<agentDir>/profile.json` — runtime identity source (name/title/…). */
export function getBotProfilePath(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'profile.json');
}

/** `<agentDir>/settings.json` — host-managed mutable settings. */
export function getBotSettingsPath(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'settings.json');
}

/**
 * Canonical avatar image filename stem; the actual extension comes from the
 * uploaded file (`avatar.png`, `avatar.svg`, … per the bot-avatar.ts whitelist).
 */
export const BOT_AVATAR_STEM = 'avatar';

/**
 * `<agentDir>/<filename>` — avatar image path. `filename` must pass
 * `isValidAvatarImageFilename` (canonical stem + whitelisted extension) so
 * nothing outside the agent directory can be addressed.
 */
export function getBotAvatarFilePath(agentId: string, filename: string, duyaRoot?: string): string {
  if (!isValidAvatarImageFilename(filename)) {
    throw new Error(`Invalid bot avatar filename: '${filename}'`);
  }
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), filename);
}

/** `<agentDir>/state` — reserved for 476 wake markers / 477 binding / 484 resume. */
export function getBotStateDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'state');
}

/** `<agentDir>/memory` — reserved for 479 per-bot memory shard (if dir-based). */
export function getBotMemoryDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'memory');
}

/**
 * `<agentDir>/sessions` — bot JSONL rollout logs (Plan 493, Phase A).
 *
 * Bot persistent sessions (`bot:<agentId>`) write their rollout to
 * `<duyaRoot>/agents/<agentId>/sessions/active.jsonl` so a bot's history
 * travels with the bot directory and is automatically cleaned up when the
 * bot is purged (490+493). Non-bot (human) sessions continue to use the
 * shared `<duyaRoot>/sessions/...` tree.
 */
export function getBotSessionsDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'sessions');
}

/**
 * `<agentDir>/sessions/active.jsonl` — single-active JSONL for a bot
 * session. Compaction rotates this to `archive-<generation>.jsonl` in the
 * same directory (493 Phase B).
 */
export function getBotSessionLogPath(agentId: string, duyaRoot?: string): string {
  return path.join(getBotSessionsDir(agentId, duyaRoot), 'active.jsonl');
}

/**
 * Plan 493 (Phase D): directory holding soft-deleted bot agent trees.
 * The dot-prefix is convention only (not enforced as a hidden attribute on
 * Windows / Linux) so operators can find it with `ls -a` / `Get-ChildItem
 * -Force`. A `<ts>-<agentId>/` subdirectory is the complete agent tree
 * moved verbatim from `<agentsDir>/<agentId>/` at soft-delete time; the
 * `<ts>` (Unix ms) prefix guarantees that a second soft-delete of the
 * same agent id — even after restore — does not collide with the
 * previous deletion.
 */
export function getBotDeletedDir(duyaRoot?: string): string {
  return path.join(getDuyaAgentsRoot(duyaRoot), '.deleted');
}

/**
 * Plan 493 (Phase D): soft-deleted bot tree path. Format
 * `<agentsRoot>/.deleted/<tsMs>-<agentId>/`. The trailing `<agentId>/`
 * matches the live tree layout exactly so `getBotProfilePath(id, duyaRoot)`
 * resolves correctly under the moved root (callers that need to read the
 * soft-deleted profile should pass `duyaRoot` AS the moved parent, not
 * the original duya root — see `softDeleteConfigAgent` for the call site).
 */
export function getBotDeletedAgentDir(
  agentId: string,
  deletedAtMs: number,
  duyaRoot?: string,
): string {
  assertValidBotId(agentId);
  return path.join(getBotDeletedDir(duyaRoot), `${deletedAtMs}-${agentId}`);
}

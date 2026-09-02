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

/** `~/.duya/agents` — root of all bot identity directories. */
export function getDuyaAgentsRoot(duyaRoot: string = resolveConfigRoot()): string {
  return path.join(duyaRoot, 'agents');
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

/** Canonical avatar file name (png preferred; the loader may probe for others). */
export const BOT_AVATAR_FILENAME = 'avatar.png';

/** `<agentDir>/avatar.png` — canonical avatar path. */
export function getBotAvatarPath(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), BOT_AVATAR_FILENAME);
}

/** `<agentDir>/state` — reserved for 476 wake markers / 477 binding / 484 resume. */
export function getBotStateDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'state');
}

/** `<agentDir>/memory` — reserved for 479 per-bot memory shard (if dir-based). */
export function getBotMemoryDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'memory');
}

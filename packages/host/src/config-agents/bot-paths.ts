/**
 * bot-paths.ts — Bot storage path derivation.
 *
 * Single source of truth for `<duyaRoot>/agents/` path construction. No other
 * module may join agent paths by hand — every consumer goes through the
 * helpers below so the directory layout stays consistent and safe.
 *
 * Layout:
 *   <duyaRoot>/agents/<agentId>/profile.json   — runtime identity source
 *   <duyaRoot>/agents/<agentId>/settings.json  — mutable settings (host)
 *   <duyaRoot>/agents/<agentId>/state/         — reserved
 *   <duyaRoot>/agents/<agentId>/memory/        — reserved
 *
 * The duya root defaults to the shared data root (`@duya/data`), which is the
 * same directory the Desktop config store writes `config.toml` into, so the
 * Desktop and the standalone Host address one agent tree.
 */

import path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';
import { assertValidBotId } from './bot-id.js';

/** `<duyaRoot>/agents` — root of all bot identity directories. */
export function getDuyaAgentsRoot(duyaRoot: string = resolveDataRoot()): string {
  return path.join(duyaRoot, 'agents');
}

/**
 * Resolve `<duyaRoot>/agents/<agentId>`. Asserts a safe bot id first so a
 * hostile/typo id can never escape the agents root (no separators, no `..`,
 * kebab-case only — see bot-id.ts).
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

/** `<agentDir>/state` — reserved for wake markers / binding / resume. */
export function getBotStateDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'state');
}

/** `<agentDir>/memory` — reserved for per-bot memory shard (if dir-based). */
export function getBotMemoryDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'memory');
}

/**
 * `<agentDir>/sessions` — bot JSONL rollout logs.
 *
 * Bot persistent sessions (`bot:<agentId>`) write their rollout to
 * `<duyaRoot>/agents/<agentId>/sessions/active.jsonl` so a bot's history
 * travels with the bot directory and is automatically cleaned up when the
 * bot is purged. Non-bot (human) sessions continue to use the shared
 * `<duyaRoot>/sessions/...` tree.
 */
export function getBotSessionsDir(agentId: string, duyaRoot?: string): string {
  return path.join(resolveDuyaAgentDir(agentId, duyaRoot), 'sessions');
}

/** `<agentDir>/sessions/active.jsonl` — single-active JSONL for a bot session. */
export function getBotSessionLogPath(agentId: string, duyaRoot?: string): string {
  return path.join(getBotSessionsDir(agentId, duyaRoot), 'active.jsonl');
}

/**
 * Directory holding soft-deleted bot agent trees. The dot-prefix is a
 * convention only (not enforced as a hidden attribute on Windows / Linux).
 * A `<ts>-<agentId>/` subdirectory is the complete agent tree moved verbatim
 * from `<agentsDir>/<agentId>/` at soft-delete time; the `<ts>` (Unix ms)
 * prefix guarantees that a second soft-delete of the same agent id — even
 * after restore — does not collide with the previous deletion.
 */
export function getBotDeletedDir(duyaRoot?: string): string {
  return path.join(getDuyaAgentsRoot(duyaRoot), '.deleted');
}

/**
 * Soft-deleted bot tree path. Format `<agentsRoot>/.deleted/<tsMs>-<agentId>/`.
 * The trailing `<agentId>/` matches the live tree layout exactly, so
 * `getBotProfilePath(id, duyaRoot)` resolves correctly under the moved root
 * (callers that need to read the soft-deleted profile should pass `duyaRoot`
 * AS the moved parent, not the original duya root).
 */
export function getBotDeletedAgentDir(
  agentId: string,
  deletedAtMs: number,
  duyaRoot?: string,
): string {
  assertValidBotId(agentId);
  return path.join(getBotDeletedDir(duyaRoot), `${deletedAtMs}-${agentId}`);
}

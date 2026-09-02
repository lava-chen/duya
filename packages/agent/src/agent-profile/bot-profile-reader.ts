/**
 * bot-profile-reader.ts — agent-core side profile.json reader (Plan 485
 * P2.2).
 *
 * The worker renders bot identity/roster from `~/.duya/agents/<id>/`
 * profile.json when present, falling back to config.toml. The Electron main
 * owns writing profile.json (electron/config/bot-profile.ts); the agent
 * process only *reads* it — mirroring the config-agents "worker reads
 * config.toml directly, no main round-trip" precedent (Plan 424).
 *
 * Path safety: agentId from config.toml is a map key the user typed, so it
 * may contain traversal characters. We join it only after the same kebab
 * validation electron uses (agent-id.ts), otherwise a `../` id could escape
 * the agents root. The pattern is intentionally duplicated here (agent-core
 * cannot import electron/config).
 */

import * as os from 'os';
import * as path from 'path';
import { readFile } from 'fs/promises';
import { resolveConfigRoot } from './config-agents.js';

/** Same kebab constraint as electron/config/agent-id.ts (Plan 485 P1.2). */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Type guard mirroring electron isSafeBotId (path-safety boundary). */
export function isSafeBotId(id: unknown): id is string {
  return typeof id === 'string' && BOT_ID_PATTERN.test(id);
}

/** Identity fields the bot sections consume (a read-only projection of
 *  profile.json; title is UI/roster display metadata, not model-updatable). */
export interface BotProfileIdentity {
  name: string;
  description?: string;
  title?: string;
}

/** `<configRoot>/agents/<agentId>/profile.json`, or null when the id is unsafe. */
export function resolveBotProfilePath(agentId: string, duyaRoot?: string): string | null {
  if (!isSafeBotId(agentId)) return null;
  const root = duyaRoot ?? resolveConfigRoot();
  return path.join(root, 'agents', agentId, 'profile.json');
}

/**
 * Read a bot's profile.json identity. Returns null when the file is missing,
 * unparseable, or the id is unsafe (the caller then falls back to config).
 */
export async function readBotProfileIdentity(
  agentId: string,
  duyaRoot?: string,
): Promise<BotProfileIdentity | null> {
  const profilePath = resolveBotProfilePath(agentId, duyaRoot);
  if (!profilePath) return null;
  try {
    const raw = await readFile(profilePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : '';
    if (!name) return null; // profile without a name is not a usable identity
    return {
      name,
      description: typeof obj.description === 'string' ? obj.description || undefined : undefined,
      title: typeof obj.title === 'string' ? obj.title.trim() || undefined : undefined,
    };
  } catch {
    return null;
  }
}

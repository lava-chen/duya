/**
 * Config-driven shared rooms (Plan 478 P1.1).
 *
 * Reads `~/.duya/groups.toml` -> `[groups.<id>]`. Mirrors `config-agents.ts`:
 * the worker reads the toml directly, no main-process round trip. The
 * main-process CRUD writer lives in `electron/config/groups.ts` and shares
 * this schema shape.
 */

import * as path from 'path';
import { readFile } from 'fs/promises';
import { parse as parseToml } from '@iarna/toml';
import { resolveConfigRoot } from './config-agents.js';

/** `[groups.<id>]` entry as written on disk (snake_case keys). */
export interface GroupEntryConfig {
  name?: string;
  /** Member agent ids (config.toml `[agents.*]` references), ≤ GROUP_MAX_MEMBERS. */
  members?: string[];
  /** Round-robin rounds per room turn (default GROUP_MAX_ROUNDS). */
  max_rounds?: number;
  /** Total member turns per room turn (default GROUP_MAX_MEMBER_TURNS). */
  max_member_turns?: number;
}

/** Resolved group used by the orchestrator + prompts. */
export interface ResolvedGroupConfig {
  id: string;
  name: string;
  memberIds: string[];
  maxRounds: number;
  maxMemberTurns: number;
}

/** Room size cap (grok GROUP_MAX_MEMBERS; rakazo GROUP_MEMBER_MAX). */
export const GROUP_MAX_MEMBERS = 6;

/** Path of the groups declaration file (`<duyaRoot>/groups.toml`). */
export function getGroupsTomlPath(duyaRoot: string = resolveConfigRoot()): string {
  return path.join(duyaRoot, 'groups.toml');
}

/** Read all `[groups.<id>]` entries. Missing file = no groups. */
export async function readConfigGroups(): Promise<Record<string, GroupEntryConfig>> {
  try {
    const raw = await readFile(getGroupsTomlPath(), 'utf8');
    const parsed = parseToml(raw) as { groups?: Record<string, unknown> };
    return (parsed.groups ?? {}) as Record<string, GroupEntryConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Clamp + default one entry (invalid values fall back to grok constants). */
export function resolveGroupConfig(id: string, entry: GroupEntryConfig): ResolvedGroupConfig {
  const clampPositive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : fallback;
  return {
    id,
    name: entry.name?.trim() || id,
    memberIds: Array.isArray(entry.members) ? entry.members.filter((m) => typeof m === 'string' && m.trim()) : [],
    maxRounds: clampPositive(entry.max_rounds, 3),
    maxMemberTurns: clampPositive(entry.max_member_turns, 10),
  };
}

/** Read + resolve every group, keyed by id. */
export async function listResolvedGroups(): Promise<Record<string, ResolvedGroupConfig>> {
  const entries = await readConfigGroups();
  const out: Record<string, ResolvedGroupConfig> = {};
  for (const [id, entry] of Object.entries(entries)) {
    out[id] = resolveGroupConfig(id, entry);
  }
  return out;
}

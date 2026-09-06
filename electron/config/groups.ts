/**
 * groups.ts — shared-room CRUD over `~/.duya/groups.toml` (Plan 478 P1.1).
 *
 * The declaration file is the single source of truth for room identity and
 * membership (plan 478 §2.1: rooms are config-side logical rooms, not
 * sessions). Parsing/reading is shared with the worker via
 * `@duya/agent`'s config-groups module; this file owns the write side:
 * validation (member existence, size cap, no group-of-groups), atomic
 * persisted writes, and the IPC-facing CRUD surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { stringify as stringifyToml } from '@iarna/toml';
import writeFileAtomic from 'write-file-atomic';
import {
  GROUP_MAX_MEMBERS,
  readConfigGroups,
  resolveGroupConfig,
  type GroupEntryConfig,
  type ResolvedGroupConfig,
} from '../../packages/agent/src/agent-profile/config-groups';
// Same root resolver the worker reader uses — main and worker MUST agree on
// the groups.toml path even under DUYA_TEST namespaces (compass' resolver
// keys off a different namespace mechanism and would split the paths).
import { resolveConfigRoot } from '../../packages/agent/src/agent-profile/config-agents';
import { listConfigAgents } from './agents';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

export { GROUP_MAX_MEMBERS };
export type { ResolvedGroupConfig };

/** Error thrown by group validation — surfaced to the renderer verbatim. */
export class GroupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupValidationError';
  }
}

function getGroupsTomlPath(): string {
  // MUST use the worker's root resolution (config-agents' resolveConfigRoot):
  // the worker reads groups.toml through the same function, so main and
  // worker must agree on the file even under DUYA_TEST namespaces (compass'
  // resolveConfigRoot keys off a different namespace mechanism and would
  // split the write/read paths).
  return `${resolveConfigRoot()}/groups.toml`;
}

/** Read + resolve every declared group, keyed by id. */
export async function listGroups(): Promise<Record<string, ResolvedGroupConfig>> {
  const entries = await readConfigGroups();
  const out: Record<string, ResolvedGroupConfig> = {};
  for (const [id, entry] of Object.entries(entries)) {
    out[id] = resolveGroupConfig(id, entry);
  }
  return out;
}

export async function getGroup(id: string): Promise<ResolvedGroupConfig | null> {
  const entries = await readConfigGroups();
  const entry = entries[id];
  return entry ? resolveGroupConfig(id, entry) : null;
}

/**
 * Validate a member list against the live bot roster. Rules (plan 478 §2.1
 * + grok assertMembersAreNotGroups): every member must be a configured
 * agent, at most GROUP_MAX_MEMBERS, no duplicates, and a group may not
 * contain another group.
 */
async function validateMembers(
  memberIds: readonly string[],
  groups: Record<string, GroupEntryConfig>,
): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length !== memberIds.length) {
    throw new GroupValidationError('Duplicate group members are not allowed.');
  }
  if (unique.length === 0) {
    throw new GroupValidationError('A group needs at least one member.');
  }
  if (unique.length > GROUP_MAX_MEMBERS) {
    throw new GroupValidationError(`A group can have at most ${GROUP_MAX_MEMBERS} members.`);
  }
  const nested = unique.filter((id) => groups[id] !== undefined);
  if (nested.length > 0) {
    throw new GroupValidationError(
      `A group can only contain individual agents, not other groups (${nested.join(', ')}).`,
    );
  }
  const agents = await listConfigAgents();
  const missing = unique.filter((id) => agents[id] === undefined);
  if (missing.length > 0) {
    throw new GroupValidationError(`Unknown group member(s): ${missing.join(', ')}.`);
  }
}

function writeGroupsToml(groups: Record<string, GroupEntryConfig>): void {
  const filePath = getGroupsTomlPath();
  // write-file-atomic creates its tmp sibling in the same directory — the
  // duya root (and the test-namespaces dir) may not exist yet on first use.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (Object.keys(groups).length === 0) {
    // An empty declaration is an empty file — but only write it when the file
    // already existed, so a delete-all does not materialize config noise on
    // fresh installs.
    if (fs.existsSync(filePath)) {
      writeFileAtomic.sync(filePath, '', { mode: 0o600 });
    }
    return;
  }
  writeFileAtomic.sync(
    filePath,
    stringifyToml({ groups } as unknown as Parameters<typeof stringifyToml>[0]) + '\n',
    { mode: 0o600 },
  );
}

async function loadEntries(): Promise<Record<string, GroupEntryConfig>> {
  return readConfigGroups();
}

function allocateGroupId(taken: ReadonlySet<string>): string {
  for (;;) {
    const candidate = `group-${randomBytes(4).toString('hex')}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface CreateGroupInput {
  name: string;
  memberIds: string[];
  maxRounds?: number;
  maxMemberTurns?: number;
}

/** Create a group; returns the resolved group including its new id. */
export async function createGroup(input: CreateGroupInput): Promise<ResolvedGroupConfig> {
  const name = input.name.trim();
  if (!name) throw new GroupValidationError('Group name is required.');
  const entries = await loadEntries();
  await validateMembers(input.memberIds, entries);
  const id = allocateGroupId(new Set(Object.keys(entries)));
  const entry: GroupEntryConfig = {
    name,
    members: [...input.memberIds],
    ...(input.maxRounds != null ? { max_rounds: input.maxRounds } : {}),
    ...(input.maxMemberTurns != null ? { max_member_turns: input.maxMemberTurns } : {}),
  };
  entries[id] = entry;
  writeGroupsToml(entries);
  logger.info('Group created', { groupId: id, members: entry.members }, LogComponent.ConfigManager);
  return resolveGroupConfig(id, entry);
}

export interface UpdateGroupInput {
  name?: string;
  memberIds?: string[];
  maxRounds?: number;
  maxMemberTurns?: number;
}

/** Update name/members/limits; only supplied fields change. */
export async function updateGroup(id: string, patch: UpdateGroupInput): Promise<ResolvedGroupConfig> {
  const entries = await loadEntries();
  const existing = entries[id];
  if (!existing) throw new GroupValidationError(`Group "${id}" does not exist.`);
  if (patch.memberIds !== undefined) {
    await validateMembers(patch.memberIds, { ...entries, [id]: undefined as unknown as GroupEntryConfig });
  }
  const next: GroupEntryConfig = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim() || id } : {}),
    ...(patch.memberIds !== undefined ? { members: [...patch.memberIds] } : {}),
    ...(patch.maxRounds !== undefined ? { max_rounds: patch.maxRounds } : {}),
    ...(patch.maxMemberTurns !== undefined ? { max_member_turns: patch.maxMemberTurns } : {}),
  };
  entries[id] = next;
  writeGroupsToml(entries);
  logger.info('Group updated', { groupId: id }, LogComponent.ConfigManager);
  return resolveGroupConfig(id, next);
}

/** Delete a group. Idempotent: deleting an unknown id is a no-op. */
export async function deleteGroup(id: string): Promise<void> {
  const entries = await loadEntries();
  if (entries[id] === undefined) return;
  delete entries[id];
  writeGroupsToml(entries);
  logger.info('Group deleted', { groupId: id }, LogComponent.ConfigManager);
}

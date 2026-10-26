/**
 * Bot context snapshot (framework plan S5).
 *
 * The prompt layer may recall only what this snapshot authorizes. The Host
 * adapter assembles one per turn from durable facts (identity revision, the
 * explicit user-shard grant, project membership, the forget revision); the
 * prompt assembly keys its frozen memory sections on `recallRevision`, so a
 * revocation or a forget lands on the next turn instead of waiting for the
 * next compaction.
 *
 * Pure by construction: parsing and the revision string use no IO. The Host
 * owns the file reads (`packages/host/src/bot/memory-access.ts`).
 *
 * Fail closed: a missing, malformed or partially invalid grant yields the
 * own shard only. Legacy shared roots (`memory/items|entities|global`) stay
 * readable because they are the user's pre-tier shared memory.
 */

import { isSafeBotId } from '../domain/bot-id.js';

/** Shard/project id shape accepted as a path segment (mirrors tierWriter). */
const SAFE_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** True when `value` can be joined into a memory path as one segment. */
export function isSafeMemorySegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT_PATTERN.test(value);
}

/** Parsed `agents/<bot>/state/memory-access.json`. */
export interface BotMemoryAccessGrant {
  /**
   * Peer bot ids whose user-tier shards this bot may recall. Sorted and
   * deduped; the bot's own id is always implicit and never listed here.
   */
  userShards: string[];
}

/** The recall scopes one snapshot authorizes. */
export interface BotMemoryRecallScopes {
  /** Legacy shared user roots — the user's pre-tier memory, always readable. */
  legacyUserRoots: boolean;
  /** The bot's own user shard (always readable). */
  ownUserShard: string;
  /** Granted peer user shards, sorted and deduped. */
  userShards: string[];
  /** Joined project ids, sorted and deduped; invalid segment shapes dropped. */
  projects: string[];
}

/** Typed context snapshot for one bot turn (framework plan S5). */
export interface BotContextSnapshot {
  botId: string;
  /** Identity revision (facade authority; 0 = pre-facade entry). */
  botRevision: number;
  /**
   * Every recall gate in one canonical string. A change re-renders the
   * frozen memory sections on the next turn.
   */
  recallRevision: string;
  memory: BotMemoryRecallScopes;
}

const EMPTY_GRANT: BotMemoryAccessGrant = { userShards: [] };

function sortedUnique(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (isSafeBotId(value)) out.add(value);
  }
  return [...out].sort();
}

/**
 * Narrow the raw grants file. Anything other than `{ userShards: string[] }`
 * is an empty grant: a corrupt file must not widen recall.
 */
export function parseMemoryAccessGrant(raw: unknown): BotMemoryAccessGrant {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_GRANT;
  const userShards = (raw as { userShards?: unknown }).userShards;
  if (!Array.isArray(userShards)) return EMPTY_GRANT;
  return { userShards: sortedUnique(userShards) };
}

export interface BotContextSnapshotInput {
  botId: string;
  /** Identity revision from the config entry; absent reads as 0. */
  botRevision?: number;
  joinedProjects: readonly unknown[];
  grant: BotMemoryAccessGrant;
  /** Durable forget counter written by the memory owner. */
  forgetRevision?: number;
}

function positiveInt(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Build the snapshot for one turn. Deterministic: the same durable facts
 * always produce the same `recallRevision`, and any change to a recall gate
 * (bot revision, joined projects, grants, forgets) produces a different one.
 */
export function buildBotContextSnapshot(input: BotContextSnapshotInput): BotContextSnapshot {
  const projects = [...new Set(input.joinedProjects)]
    .filter((id): id is string => isSafeMemorySegment(id))
    .sort();
  const userShards = sortedUnique(input.grant.userShards).filter((id) => id !== input.botId);
  const botRevision = positiveInt(input.botRevision);
  const forgetRevision = positiveInt(input.forgetRevision);
  return {
    botId: input.botId,
    botRevision,
    recallRevision: [
      `bot:${botRevision}`,
      `forget:${forgetRevision}`,
      `project:${projects.join('+') || '-'}`,
      `user:${userShards.join('+') || '-'}`,
    ].join('|'),
    memory: {
      legacyUserRoots: true,
      ownUserShard: input.botId,
      userShards,
      projects,
    },
  };
}

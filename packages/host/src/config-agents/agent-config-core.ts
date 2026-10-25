/**
 * agent-config-core.ts — the Host's config-agent rules shared with the
 * Desktop config store.
 *
 * The PURE identity rules (upsert merge, id slug, soft-delete test) moved to
 * `@duya/bot` (framework plan S2) and are re-exported here so this module's
 * internal importers keep one path. What remains is what IO or Host policy
 * owns: the on-disk taken-id scan, the profile seeding, the crypto id-minting
 * suffix, and the Desktop's looser config-key assertion.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBotDeletedDir, getBotProfilePath, getDuyaAgentsRoot } from './bot-paths.js';
import { isSafeBotId } from './bot-id.js';
import { writeBotProfile } from './bot-profile.js';
import type { BotIdentityEntry } from '@duya/bot';

// Identity rules moved to @duya/bot (framework plan S2); the Host re-exports
// them so `config-agents-api.ts` and the barrel keep one import path.
export {
  buildUpsertedAgent,
  isSoftDeletedConfigAgent,
  slugifyBotIdFromName,
} from '@duya/bot';
import { allocateBotId as allocateBotIdRule } from '@duya/bot';

/**
 * Assert the id is usable as a config key.
 *
 * The Desktop upsert historically used a looser pattern than the bot-id
 * safety pattern (no length cap): an id is checked against this rule before
 * it becomes a `[agents.<id>]` table, and against the stricter bot-id rule
 * before it becomes a directory name.
 */
export function assertConfigAgentId(id: string): void {
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`agent id must be lowercase alphanumeric + dashes, got '${id}'`);
  }
}

/**
 * Every bot id that must be treated as taken because of what is on disk:
 *   1. every directory under `<agentsRoot>/` (hard-delete leftovers, trees
 *      written out-of-band by older builds),
 *   2. ids recovered from `.deleted/<deletedAt>-<id>/` tombstones.
 */
export function collectTakenBotIdsFromDisk(duyaRoot: string): Set<string> {
  const taken = new Set<string>();
  const agentsRoot = getDuyaAgentsRoot(duyaRoot);
  const deletedDirName = path.basename(getBotDeletedDir(duyaRoot));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return taken; // agents root does not exist yet — disk view only
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === deletedDirName) {
      // Tombstone dir names carry the deletion timestamp as a prefix;
      // recover the agent id from `<ts>-<id>`.
      try {
        for (const tomb of fs.readdirSync(path.join(agentsRoot, entry.name))) {
          const match = /^\d+-([a-z0-9][a-z0-9-]{0,62})$/.exec(tomb);
          if (match) taken.add(match[1]!);
        }
      } catch {
        // Unreadable tombstone dir — skip it rather than fail allocation.
      }
      continue;
    }
    taken.add(entry.name);
  }
  return taken;
}

/**
 * Every taken bot id: the config keys (live AND soft-deleted) plus the disk
 * view. This is the only id minting point — a freshly created bot can never
 * collide with a deleted bot's stale on-disk tree.
 */
export function mergeTakenBotIds(configIds: Iterable<string>, duyaRoot: string): Set<string> {
  const taken = new Set<string>(configIds);
  for (const id of collectTakenBotIdsFromDisk(duyaRoot)) taken.add(id);
  return taken;
}

/** 6 lowercase hex chars — always inside the bot-id charset. */
function randomBotIdSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * Allocate a unique bot id. `desiredId` wins when free; otherwise
 * `<desiredId>-<6 hex chars>` is retried until unique. The base is
 * truncated to 48 chars so the worst case (48 + dash + 6 = 55) stays
 * inside the 63-char bot-id limit. The pure rule lives in `@duya/bot`; this
 * wrapper supplies the node:crypto suffix the Host owns.
 */
export function allocateBotId(desiredId: string, taken: ReadonlySet<string>): string {
  return allocateBotIdRule(desiredId, taken, randomBotIdSuffix);
}

/**
 * On first creation, seed `agents/<id>/profile.json` from the config entry.
 * Best-effort — a profile write failure must never roll back the config save.
 * Existing profiles are never overwritten (runtime identity wins). Ids that
 * fail the bot-id rule (e.g. legacy config keys) skip seeding.
 *
 * Returns true when a profile was written.
 */
export function seedBotProfileIfMissing(
  duyaRoot: string,
  id: string,
  entry: BotIdentityEntry,
  opts: {
    avatarColor?: string | undefined;
    title?: string | undefined;
    onError?: ((error: unknown) => void) | undefined;
  } = {},
): boolean {
  if (!isSafeBotId(id)) return false;
  try {
    const profilePath = getBotProfilePath(id, duyaRoot);
    if (fs.existsSync(profilePath)) return false;
    writeBotProfile(profilePath, {
      name: entry.name || id,
      title: opts.title?.trim() || '',
      description: entry.description ?? '',
      avatarColor: opts.avatarColor?.trim() || undefined,
    });
    return true;
  } catch (error) {
    // Best-effort: a profile seeding failure must not fail the config write.
    opts.onError?.(error);
    return false;
  }
}

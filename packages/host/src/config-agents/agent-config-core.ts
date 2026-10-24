/**
 * agent-config-core.ts — the config-agent rules shared by the Desktop config
 * store and the standalone Host.
 *
 * Everything here is pure (or a read-only disk scan) so both writers agree on
 * one answer: how an agent id is derived, which ids are taken, and which
 * fields an upsert preserves. The storage backend differs — the Desktop
 * writes through its in-memory config store, the Host writes the TOML file
 * directly — but the rules must not.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBotDeletedDir, getBotProfilePath, getDuyaAgentsRoot } from './bot-paths.js';
import { isSafeBotId } from './bot-id.js';
import { writeBotProfile } from './bot-profile.js';
import type { AgentUpsertInput, CustomAgentConfig } from './agent-config-schema.js';

/**
 * True iff `cfg` is in the soft-deleted state. The field is nullable because
 * a JSON round-trip restores `undefined` to `undefined` and `null` to `null`;
 * both mean "live".
 */
export function isSoftDeletedConfigAgent(cfg: CustomAgentConfig | undefined): boolean {
  return !!(cfg && typeof cfg.deleted_at === 'number' && cfg.deleted_at > 0);
}

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
 * Derive a bot id candidate from a display name. The caller only supplies a
 * name, no id. Slug rules: lowercase, non-alphanumerics collapse to dashes,
 * and non-ASCII names (e.g. Chinese) fall back to the generic `bot` base.
 * Uniqueness itself is `allocateBotId`'s job.
 */
export function slugifyBotIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug.length >= 2 ? slug : 'bot';
  return /^[a-z0-9][a-z0-9-]*$/.test(base) ? base : 'bot';
}

/**
 * Merge an upsert input over the stored entry.
 *
 * The merge rules are the contract:
 *   - `name` / `description` / `model` / `workspace` / `agents_md` are replaced
 *     by the input (absent → cleared).
 *   - `provider` and `reasoning` only change when the caller carries them:
 *     a caller patching the name must not drop the provider binding.
 *   - `tools` / `plugins` only survive when the input carries a non-empty set.
 *   - `prompt` is hand-edited TOML config — the upsert input has no prompt
 *     surface, so the existing table is preserved.
 *   - the soft-delete fields are never carried over: an upsert is a live
 *     agent by definition.
 */
export function buildUpsertedAgent(
  existing: CustomAgentConfig | undefined,
  input: AgentUpsertInput,
): CustomAgentConfig {
  if (!input.name || !input.name.trim()) {
    throw new Error('agent name is required');
  }
  return {
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    model: input.model?.trim() || undefined,
    provider:
      input.provider !== undefined ? input.provider.trim() || undefined : existing?.provider,
    reasoning:
      input.reasoning !== undefined ? input.reasoning : existing?.reasoning,
    workspace: input.workspace?.trim() || undefined,
    agents_md: input.agents_md?.trim() || undefined,
    tools: input.tools && Object.keys(input.tools).length ? input.tools : undefined,
    plugins: input.plugins && input.plugins.length ? input.plugins : undefined,
    prompt: existing?.prompt,
  };
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
 * inside the 63-char bot-id limit.
 */
export function allocateBotId(desiredId: string, taken: ReadonlySet<string>): string {
  if (!isSafeBotId(desiredId)) {
    throw new Error(
      `Invalid bot id '${desiredId}': must match /^[a-z0-9][a-z0-9-]{0,62}$/ (kebab-case, starts with a lowercase letter or digit, max 63 chars)`,
    );
  }
  if (!taken.has(desiredId)) return desiredId;
  const base = desiredId.slice(0, 48);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `${base}-${randomBotIdSuffix()}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique bot id from '${desiredId}'`);
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
  entry: CustomAgentConfig,
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

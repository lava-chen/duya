/**
 * Shared config-agents write module (custom agent creation).
 * Mutates ConfigStore `agents` map and persists via the store.
 * Single write path for form (IPC) and CLI (HTTP route).
 *
 * Plan 485 §2.4: the FIRST creation of a bot also seeds its runtime
 * identity file (`agents/<id>/profile.json`) from the config name /
 * description. Later updates write config.toml only — runtime identity
 * (which the model may change via update_state, Plan 481) lives in
 * profile.json and is never overwritten by config saves.
 *
 * Plan 493 (Phase D): soft-delete via `deleted_at` / `deleted_reason` /
 * `deleted_purge_at` fields on the agent's CustomAgentConfig. Live agents
 * keep these fields null; soft-deleted agents have them set, are filtered
 * out of `listConfigAgents` / `getConfigAgent`, and their on-disk tree
 * lives under `<agentsDir>/.deleted/<deletedAt>-<id>/`.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { CustomAgentConfig } from './schema.js';
import { getConfigStore } from './store-instance.js';
import { assertValidBotId, isSafeBotId } from './agent-id.js';
import {
  getBotAvatarFilePath,
  getBotDeletedAgentDir,
  getBotDeletedDir,
  getBotProfilePath,
  getDuyaAgentsRoot,
  resolveDuyaAgentDir,
} from './agent-paths.js';
import { readBotProfile, writeBotProfile, type BotProfile, type BotProfileInput } from './bot-profile.js';
import {
  BOT_AVATAR_MAX_BYTES,
  avatarSourceExtension,
  isValidAvatarImageFilename,
} from './bot-avatar.js';

export interface AgentUpsertInput {
  name: string;
  description?: string;
  /** Role subtitle — profile.json ONLY (485 §2.4), never stored in config.toml. */
  title?: string;
  model?: string;
  /** Provider store id the `model` belongs to. Absent → preserve the existing value. */
  provider?: string;
  /** Thinking level bound to the model ('off'|'low'|'medium'|'high'). Absent → preserve the existing value. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
  /** Color token for the initial-circle avatar, seeded into `agents/<id>/profile.json` on first creation. */
  avatarColor?: string;
}

/** Plan 493 (Phase D): a soft-deleted agent record for the drawer / IPC. */
export interface DeletedConfigAgent {
  id: string;
  deletedAt: number;
  deletedReason: string | null;
  deletedPurgeAt: number | null;
  /** Absolute path of the moved agent tree under `.deleted/`. */
  path: string;
}

/** Plan 493 (Phase D): default soft-delete grace period: 30 days. */
export const SOFT_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True iff `cfg` is in the soft-deleted state. The CustomAgentConfig
 * field is nullable because JSON round-trip restores `undefined` to
 * `undefined` and `null` to `null`; both mean "live".
 */
export function isSoftDeletedConfigAgent(cfg: CustomAgentConfig | undefined): boolean {
  return !!(cfg && typeof cfg.deleted_at === 'number' && cfg.deleted_at > 0);
}

/**
 * Plan 493 (Phase D): list live config-agents only. Soft-deleted agents
 * (those with a non-null `deleted_at`) are filtered out — they live in
 * `listDeletedConfigAgents` for the drawer.
 */
export function listConfigAgents(): Record<string, CustomAgentConfig> {
  const store = getConfigStore();
  const all = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const live: Record<string, CustomAgentConfig> = {};
  for (const [id, cfg] of Object.entries(all)) {
    if (isSoftDeletedConfigAgent(cfg)) continue;
    live[id] = cfg;
  }
  return live;
}

/**
 * Plan 493 (Phase D): `getConfigAgent` returns the entry as stored
 * INCLUDING soft-deleted ones — callers that want the strict live view
 * should use the filter `!isSoftDeletedConfigAgent(cfg)`. `getConfigAgent`
 * historically surfaced every config entry (a missing row is a 404).
 * Changing the default here would silently break callers that want to
 * inspect a soft-deleted bot (the drawer needs the deleted metadata).
 *
 * Use `getLiveConfigAgent` for the strict live filter — it is what the
 * sidebar / IPC create-session / edit-dialog call paths should use.
 */
export function getConfigAgent(id: string): CustomAgentConfig | undefined {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  return agents[id];
}

/** Plan 493 (Phase D): strict live-only getter for sidebar / IPC hot paths. */
export function getLiveConfigAgent(id: string): CustomAgentConfig | undefined {
  const cfg = getConfigAgent(id);
  if (!cfg) return undefined;
  if (isSoftDeletedConfigAgent(cfg)) return undefined;
  return cfg;
}

/** One bot in the sidebar Bots section — merged config declaration + profile identity. */
export interface BotListItem {
  id: string;
  /** Display identity — profile name wins, else config name, else the id. */
  name: string;
  /** Role subtitle (profile.json only; not seeded from config). */
  title: string;
  description: string;
  model?: string;
  /** Provider store id the configured `model` belongs to. */
  provider?: string;
  /** Thinking level bound to the model ('off'|'low'|'medium'|'high'); absent → runtime default medium. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  workspace?: string;
  avatarColor?: string;
  /** `duya-file://` URL of the bot's avatar image, with `?v=<mtime>` cache-buster (absent when no image). */
  avatarUrl?: string;
  /** Avatar image mtime (ms) backing `avatarUrl`; renderer-side change detection. */
  avatarVersion?: number;
}

/**
 * Plan 483 P1.2 read side for the sidebar Bots section. Each configured
 * `[agents.<id>]` is merged with its runtime identity (`agents/<id>/profile.json`,
 * plan 485 §2.4) — profile wins for name/title/description/avatar, config
 * supplies model/workspace and the display fallback.
 */
export function listBots(): BotListItem[] {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const duyaRoot = store.getConfigDir();
  const out: BotListItem[] = [];
  for (const [id, cfg] of Object.entries(agents)) {
    // Plan 493 Phase D: soft-deleted bots are tombstones, not contacts —
    // they must not surface in the sidebar or in the create dialog's
    // collision set as if they were live bots.
    if (isSoftDeletedConfigAgent(cfg)) continue;
    // Legacy/hostile config keys (not legal bot ids) skip the profile merge
    // but still surface from config alone. Never throw for a bad key here.
    let profile: BotProfile | null = null;
    if (isSafeBotId(id)) {
      try {
        profile = readBotProfile(getBotProfilePath(id, duyaRoot));
      } catch {
        profile = null;
      }
    }
    out.push({
      id,
      name: profile?.name || cfg.name || id,
      title: profile?.title ?? '',
      description: profile?.description || cfg.description || '',
      model: cfg.model,
      provider: cfg.provider,
      workspace: cfg.workspace,
      reasoning: cfg.reasoning,
      avatarColor: profile?.avatarColor,
      avatarEmoji: profile?.avatarEmoji,
      ...buildBotAvatarEntry(id, profile?.avatarImage, duyaRoot),
    });
  }
  return out;
}

/**
 * Resolve a bot's avatar image into renderer-facing fields. Returns
 * `{ avatarUrl, avatarVersion }` when the profile names a whitelisted
 * avatar file that actually exists on disk; `{}` otherwise (renderer falls
 * back to the color circle). The `duya-file://` protocol handler in main.ts
 * serves the bytes; `?v=<mtime>` busts its 1h cache after an upload.
 */
function buildBotAvatarEntry(
  id: string,
  avatarImage: string | undefined,
  duyaRoot: string,
): { avatarUrl?: string; avatarVersion?: number } {
  if (!avatarImage || !isValidAvatarImageFilename(avatarImage) || !isSafeBotId(id)) return {};
  try {
    const filePath = getBotAvatarFilePath(id, avatarImage, duyaRoot);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return {};
    const url = `duya-file:///${filePath.replace(/\\/g, '/')}?v=${stat.mtimeMs}`;
    return { avatarUrl: url, avatarVersion: stat.mtimeMs };
  } catch {
    return {};
  }
}

export function upsertConfigAgent(id: string, input: AgentUpsertInput): CustomAgentConfig {
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`agent id must be lowercase alphanumeric + dashes, got '${id}'`);
  }
  if (!input.name || !input.name.trim()) {
    throw new Error('agent name is required');
  }
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const isNewAgent = !(id in agents);
  // Plan 493 Phase D: never silently resurrect a soft-deleted entry — its
  // on-disk tree lives under `.deleted/<ts>-<id>/` and would be orphaned
  // while the config row pretends nothing happened. Callers must restore or
  // purge first; the create IPC allocates a fresh id instead (allocateBotId).
  if (isSoftDeletedConfigAgent(agents[id])) {
    throw new Error(`agent '${id}' is soft-deleted; restore or purge it before re-creating`);
  }
  const next: CustomAgentConfig = {
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    model: input.model?.trim() || undefined,
    // Provider only changes when the caller carries it (the settings forms
    // always do); callers that patch other fields must not drop the binding.
    provider: input.provider !== undefined
      ? input.provider.trim() || undefined
      : agents[id]?.provider,
    // Reasoning only changes when the caller carries it; patch callers must
    // not drop the bound thinking level.
    reasoning: input.reasoning !== undefined
      ? input.reasoning
      : agents[id]?.reasoning,
    workspace: input.workspace?.trim() || undefined,
    agents_md: input.agents_md?.trim() || undefined,
    tools: input.tools && Object.keys(input.tools).length ? input.tools : undefined,
    plugins: input.plugins && input.plugins.length ? input.plugins : undefined,
    // Plan 474 P3.2: `[agents.<id>.prompt]` is hand-edited toml config —
    // the upsert input has no prompt surface, so preserve the existing
    // table instead of dropping it on re-upsert.
    prompt: agents[id]?.prompt,
  };
  agents[id] = next;
  store.set('agents', agents);
  if (isNewAgent) {
    seedBotProfileIfMissing(id, next, store, input.avatarColor, input.title, input.avatarEmoji);
  }
  return next;
}

/**
 * Plan 485 P2.1: on first creation, seed `agents/<id>/profile.json` from
 * the config entry. Best-effort — a profile write failure must never roll
 * back the config save. Existing profiles are never overwritten (runtime
 * identity wins). Ids that fail `isSafeBotId` (e.g. legacy config keys)
 * skip seeding until a migration tool lands (485 Phase 4).
 */
function seedBotProfileIfMissing(
  id: string,
  entry: CustomAgentConfig,
  store: { getConfigDir(): string },
  avatarColor?: string,
  title?: string,
): void {
  if (!isSafeBotId(id)) return;
  try {
    const profilePath = getBotProfilePath(id, store.getConfigDir());
    if (fs.existsSync(profilePath)) return;
    writeBotProfile(profilePath, {
      name: entry.name || id,
      title: title?.trim() || '',
      description: entry.description ?? '',
      avatarColor: avatarColor?.trim() || undefined,
    });
  } catch (err) {
    // Best-effort: logging infra may not be wired in all callers yet.
    // eslint-disable-next-line no-console
    console.warn(`[config-agents] failed to seed profile for '${id}':`, err);
  }
}

/**
 * Collect every bot id that must be treated as taken when allocating a new
 * id — the main process's authoritative view:
 *   1. every config.toml `[agents.<id>]` key (live AND soft-deleted),
 *   2. every directory under `<agentsRoot>/` (hard-delete leftovers, trees
 *      written out-of-band by older builds),
 *   3. ids recovered from `.deleted/<deletedAt>-<id>/` tombstones.
 * This is the ONLY id minting point since Plan 502 — the renderer passes a
 * name (or an optional desired id hint) and main allocates here, which is
 * also why a freshly created bot can no longer collide with a deleted
 * bot's stale on-disk tree.
 */
export function collectTakenBotIds(duyaRoot?: string): Set<string> {
  const taken = new Set<string>();
  const store = getConfigStore();
  const root = duyaRoot ?? store.getConfigDir();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  for (const id of Object.keys(agents)) taken.add(id);

  const agentsRoot = getDuyaAgentsRoot(root);
  const deletedDirName = path.basename(getBotDeletedDir(root));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return taken; // agents root does not exist yet — config view only
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

/** 6 lowercase hex chars — always inside BOT_ID_PATTERN's charset. */
function randomBotIdSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * Allocate a unique bot id. `desiredId` wins when free; otherwise
 * `<desiredId>-<6 hex chars>` is retried until unique. The base is
 * truncated to 48 chars so the worst case (48 + dash + 6 = 55) stays
 * inside the 63-char BOT_ID_PATTERN limit.
 */
export function allocateBotId(desiredId: string, duyaRoot?: string): string {
  assertValidBotId(desiredId);
  const taken = collectTakenBotIds(duyaRoot);
  if (!taken.has(desiredId)) return desiredId;
  const base = desiredId.slice(0, 48);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `${base}-${randomBotIdSuffix()}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique bot id from '${desiredId}'`);
}

/** Result of a create-semantics bot creation — `id` is the ACTUAL id. */
export interface CreatedConfigAgent {
  id: string;
  config: CustomAgentConfig;
}

/**
 * Create-semantics entry point for the `config:agents:create` IPC: picks a
 * guaranteed-unique id (config + disk + tombstones, see collectTakenBotIds)
 * and then upserts. Returns the actual id so the renderer can navigate to
 * the right bot even when the requested id had to be suffixed.
 */
export function createConfigAgentUnique(desiredId: string, input: AgentUpsertInput): CreatedConfigAgent {
  const id = allocateBotId(desiredId);
  return { id, config: upsertConfigAgent(id, input) };
}

/**
 * Derive a bot id candidate from a display name (Plan 492 P4 CreateAgent
 * tool path and Plan 502 UI path — the caller only supplies a name, no id).
 * Slug rules: lowercase, non-alphanumerics collapse to dashes, and
 * non-ASCII names (e.g. Chinese) fall back to the generic `bot` base.
 * Uniqueness itself is allocateBotId's job.
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
 * Plan 492 P4.2: create-semantics entry for the agent-side CreateAgent tool
 * (agent subprocess → db-bridge). The model supplies name + persona only;
 * the id is derived from the name and made collision-free by allocateBotId.
 * Profile.json seeding (Plan 485 §2.4) happens inside upsertConfigAgent.
 */
export function createConfigAgentFromName(
  name: string,
  description?: string,
  avatarEmoji?: string,
): CreatedConfigAgent {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('agent name is required');
  return createConfigAgentUnique(slugifyBotIdFromName(trimmed), {
    name: trimmed,
    description: description?.trim() || undefined,
    avatarEmoji: avatarEmoji?.trim() || undefined,
  });
}

/** Fields the agent-side UpdateAgent tool may change (grok parity). */
export interface AgentIdentityPatch {
  name?: string;
  description?: string;
  avatarEmoji?: string;
}

/**
 * Plan 492 P4.2: patch-semantics entry for the agent-side UpdateAgent tool.
 * grok parity: only the provided identity fields change; model / workspace /
 * tools / plugins / prompt table are preserved exactly. Throws when the id
 * is unknown (the tool turns this into a helpful error string).
 */
export function patchConfigAgentIdentity(id: string, patch: AgentIdentityPatch): CustomAgentConfig {
  const existing = getConfigAgent(id);
  if (!existing) throw new Error(`agent '${id}' not found`);
  // Explicit field pick: CustomAgentConfig carries soft-delete fields
  // (deleted_at / deleted_reason / deleted_purge_at) that must NOT ride
  // into the upsert input — upsertConfigAgent rebuilds the entry from
  // AgentUpsertInput only.
  return upsertConfigAgent(id, {
    name:
      patch.name !== undefined && patch.name.trim()
        ? patch.name.trim()
        : existing.name ?? id,
    description:
      patch.description !== undefined && patch.description.trim()
        ? patch.description.trim()
        : existing.description,
    avatarEmoji:
      patch.avatarEmoji !== undefined && patch.avatarEmoji.trim()
        ? patch.avatarEmoji.trim()
        : readBotProfile(getBotProfilePath(id, getConfigStore().getConfigDir()))?.avatarEmoji,
    model: existing.model,
    workspace: existing.workspace,
    agents_md: existing.agents_md,
    tools: existing.tools,
    plugins: existing.plugins,
  });
}

export function deleteConfigAgent(id: string): boolean {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  if (!(id in agents)) return false;
  delete agents[id];
  store.set('agents', agents);

  // Hard delete removes the whole runtime tree (profile.json, memory,
  // sessions, channel secrets) so an agent re-created later can never
  // inherit stale state — mirrors grok-bot's physical delete. Recoverable
  // deletion is softDeleteConfigAgent (Plan 493 Phase D), which moves the
  // tree under `.deleted/` instead. Legacy/hostile config keys are not
  // legal bot ids and have no agent tree to remove.
  if (isSafeBotId(id)) {
    try {
      const agentDir = resolveDuyaAgentDir(id, store.getConfigDir());
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Config cleanup already succeeded — never fail the delete on disk.
      // eslint-disable-next-line no-console
      console.warn(`[config-agents] failed to remove agent dir for '${id}':`, err);
    }
  }

  return true;
}

/**
 * Plan 493 (Phase D): soft-delete a config-registered bot. The agent's
 * on-disk tree is moved under `<agentsDir>/.deleted/<deletedAt>-<id>/`
 * and the config entry is stamped with `deleted_at` / `deleted_reason`
 * / `deleted_purge_at`. `listConfigAgents` will filter it out from the
 * sidebar; the drawer (`listDeletedConfigAgents`) shows the tombstone.
 *
 * The function is idempotent: calling soft-delete twice on the same
 * agent is a no-op when the entry is already soft-deleted (returns the
 * existing record). Calling soft-delete on a missing agent throws.
 *
 * The on-disk rename uses `fs.renameSync` — on POSIX this is atomic for
 * same-filesystem moves; on Windows + NTFS it is best-effort. Both
 * `<agentsDir>/<id>/` and `<agentsDir>/.deleted/<ts>-<id>/` live on the
 * same filesystem (both under `~/.duya/agents/`), so cross-device
 * rename failure (EXDEV) is not a concern in practice.
 */
export function softDeleteConfigAgent(
  id: string,
  opts: { reason?: string | null; deletedAt?: number; graceMs?: number } = {},
): DeletedConfigAgent {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const cfg = agents[id];
  if (!cfg) {
    throw new Error(`agent '${id}' not found`);
  }
  // Idempotent: already soft-deleted? return the existing record instead of
  // creating a second `<ts>-<id>/` directory.
  if (isSoftDeletedConfigAgent(cfg)) {
    const deletedAt = cfg.deleted_at!;
    return {
      id,
      deletedAt,
      deletedReason: cfg.deleted_reason ?? null,
      deletedPurgeAt: cfg.deleted_purge_at ?? null,
      path: getBotDeletedAgentDir(id, deletedAt, store.getConfigDir()),
    };
  }

  const deletedAt = opts.deletedAt ?? Date.now();
  const graceMs = opts.graceMs ?? SOFT_DELETE_GRACE_MS;
  const deletedPurgeAt = deletedAt + graceMs;

  // Move the on-disk tree. The agent dir might not exist (a config-only
  // entry that never wrote a profile) — in that case skip the rename and
  // just stamp the config.
  const duyaRoot = store.getConfigDir();
  const liveDir = resolveDuyaAgentDir(id, duyaRoot);
  const deletedDir = getBotDeletedAgentDir(id, deletedAt, duyaRoot);
  if (fs.existsSync(liveDir)) {
    fs.mkdirSync(path.dirname(deletedDir), { recursive: true });
    fs.renameSync(liveDir, deletedDir);
  }

  // Stamp the config entry.
  agents[id] = {
    ...cfg,
    deleted_at: deletedAt,
    deleted_reason: opts.reason ?? null,
    deleted_purge_at: deletedPurgeAt,
  };
  store.set('agents', agents);

  return {
    id,
    deletedAt,
    deletedReason: opts.reason ?? null,
    deletedPurgeAt,
    path: deletedDir,
  };
}

/**
 * Plan 493 (Phase D): restore a soft-deleted bot by reversing the
 * soft-delete tree move. The most-recent soft-delete tombstone wins
 * (a single agent id may have multiple `<ts>-<id>/` entries if the
 * user soft-deleted, restored, and then soft-deleted again — we always
 * restore the latest).
 *
 * Throws if the agent is not currently soft-deleted (live agents have
 * nothing to restore from) or if the live dir is already occupied by a
 * non-deleted tree (the user must delete the live one first).
 */
export function restoreConfigAgent(id: string, opts: { restoredAt?: number } = {}): {
  id: string;
  restoredAt: number;
  path: string;
} {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const cfg = agents[id];
  if (!cfg) {
    throw new Error(`agent '${id}' not found`);
  }
  if (!isSoftDeletedConfigAgent(cfg)) {
    throw new Error(`agent '${id}' is not soft-deleted`);
  }
  const deletedAt = cfg.deleted_at!;
  const duyaRoot = store.getConfigDir();
  const deletedDir = getBotDeletedAgentDir(id, deletedAt, duyaRoot);
  const liveDir = resolveDuyaAgentDir(id, duyaRoot);

  if (fs.existsSync(liveDir)) {
    // The live dir is occupied — refuse rather than silently overwrite.
    // Caller must remove or rename the live one first.
    throw new Error(
      `cannot restore '${id}': live directory already exists at ${liveDir}`,
    );
  }
  if (!fs.existsSync(deletedDir)) {
    // Tombstone gone from disk but DB still says deleted — clear the
    // soft-delete stamps so the live config is consistent, but warn.
    agents[id] = { ...cfg };
    delete agents[id].deleted_at;
    delete agents[id].deleted_reason;
    delete agents[id].deleted_purge_at;
    store.set('agents', agents);
    return { id, restoredAt: opts.restoredAt ?? Date.now(), path: liveDir };
  }
  fs.mkdirSync(path.dirname(liveDir), { recursive: true });
  fs.renameSync(deletedDir, liveDir);

  // Clear the soft-delete stamps.
  agents[id] = { ...cfg };
  delete agents[id].deleted_at;
  delete agents[id].deleted_reason;
  delete agents[id].deleted_purge_at;
  store.set('agents', agents);

  return { id, restoredAt: opts.restoredAt ?? Date.now(), path: liveDir };
}

/**
 * Plan 493 (Phase D): list all currently-soft-deleted bots for the
 * sidebar drawer. Returns one record per agent id whose config entry has
 * `deleted_at` set, ordered by `deleted_at` descending (newest first).
 */
export function listDeletedConfigAgents(): DeletedConfigAgent[] {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const out: DeletedConfigAgent[] = [];
  for (const [id, cfg] of Object.entries(agents)) {
    if (!isSoftDeletedConfigAgent(cfg)) continue;
    const deletedAt = cfg.deleted_at!;
    out.push({
      id,
      deletedAt,
      deletedReason: cfg.deleted_reason ?? null,
      deletedPurgeAt: cfg.deleted_purge_at ?? null,
      path: getBotDeletedAgentDir(id, deletedAt, store.getConfigDir()),
    });
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

/**
 * Plan 493 (Phase D): physically remove every soft-deleted agent whose
 * `deleted_purge_at` is older than `now - olderThanMs`. The on-disk
 * tree under `.deleted/<ts>-<id>/` is removed with `fs.rmSync({
 * recursive: true, force: true })` and the config entry is deleted.
 *
 * `dryRun: true` returns the candidate list + the bytes that WOULD be
 * freed without performing any IO. Useful for the drawer's "Purge now"
 * preview.
 */
export function purgeDeletedConfigAgents(opts: {
  olderThanMs?: number;
  now?: number;
  dryRun?: boolean;
}): { purgedIds: string[]; candidates: DeletedConfigAgent[]; dryRun: boolean; totalBytes: number } {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? 0);

  const candidates: DeletedConfigAgent[] = [];
  for (const [id, cfg] of Object.entries(agents)) {
    if (!isSoftDeletedConfigAgent(cfg)) continue;
    const purgeAt = cfg.deleted_purge_at ?? Number.MAX_SAFE_INTEGER;
    if (purgeAt >= cutoff) continue;
    const deletedAt = cfg.deleted_at!;
    candidates.push({
      id,
      deletedAt,
      deletedReason: cfg.deleted_reason ?? null,
      deletedPurgeAt: purgeAt,
      path: getBotDeletedAgentDir(id, deletedAt, store.getConfigDir()),
    });
  }

  if (opts.dryRun) {
    // Compute the on-disk footprint without mutating anything. Skip stat
    // errors (a stale `<ts>-<id>/` already removed by an operator).
    let totalBytes = 0;
    for (const c of candidates) {
      totalBytes += safeDirSize(c.path);
    }
    return { purgedIds: [], candidates, dryRun: true, totalBytes };
  }

  const purgedIds: string[] = [];
  let totalBytes = 0;
  for (const c of candidates) {
    const size = safeDirSize(c.path);
    try {
      if (fs.existsSync(c.path)) {
        fs.rmSync(c.path, { recursive: true, force: true });
      }
    } catch (err) {
      // Continue with the config cleanup even if the disk move failed —
      // a stale tombstone is harmless compared to a stranded config row.
      // eslint-disable-next-line no-console
      console.warn(`[config-agents] purge: failed to remove ${c.path}:`, err);
    }
    delete agents[c.id];
    purgedIds.push(c.id);
    totalBytes += size;
  }
  store.set('agents', agents);

  return { purgedIds, candidates, dryRun: false, totalBytes };
}

/**
 * Best-effort recursive byte counter for a directory. Symlinks are
 * followed (matches `rmSync` behavior on Windows + macOS); unreadable
 * subtrees count as 0. Used by `purgeDeletedConfigAgents` for the
 * dry-run preview.
 */
function safeDirSize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  };
  walk(root);
  return total;
}

/**
 * Plan 483 P2: UI edits to a bot's display identity (sidebar edit dialog)
 * land in `agents/<id>/profile.json` — the runtime identity source
 * (plan 485 §2.4). config.toml name/description are the seed/fallback and
 * are never overwritten here (the model may own profile changes via
 * update_state). Existing profile fields not touched by the edit are
 * preserved; a legacy config-only agent (no profile yet) is seeded from
 * the config entry first.
 */
export interface BotIdentityInput {
  name?: string;
  title?: string;
  description?: string;
  avatarColor?: string;
  avatarEmoji?: string;
}

export function updateBotProfileIdentity(
  id: string,
  input: BotIdentityInput,
): BotProfile | null {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const cfg = agents[id];
  if (!cfg) throw new Error(`agent '${id}' not found`);
  if (!isSafeBotId(id)) {
    throw new Error(`agent id '${id}' cannot host a runtime profile`);
  }
  const profilePath = getBotProfilePath(id, store.getConfigDir());
  const existing = readBotProfile(profilePath);
  const next: BotProfileInput = {
    name: input.name?.trim() || existing?.name || cfg.name || id,
    title:
      input.title !== undefined
        ? input.title.trim()
        : (existing?.title ?? ''),
    description:
      input.description !== undefined
        ? input.description.trim()
        : (existing?.description ?? cfg.description ?? ''),
    avatarColor: input.avatarColor?.trim() || existing?.avatarColor,
    avatarEmoji: input.avatarEmoji?.trim() || existing?.avatarEmoji,
    // Avatar image filename is managed by setBotAvatarImage/clearBotAvatarImage
    // (upload / update_state avatar.set) — an identity edit never drops it.
    avatarImage: existing?.avatarImage,
  };
  return writeBotProfile(profilePath, next);
}

/**
 * Plan 481 amendment: clear a bot's avatar (update_state avatar.clear).
 * `updateBotProfileIdentity` cannot express removal (empty string falls
 * back to the existing token), so this writes the profile with the color
 * token and avatar image explicitly absent, and deletes the avatar image
 * file. Returns null when no profile exists (nothing to clear — already
 * default).
 */
export function clearBotAvatarTokens(id: string): BotProfile | null {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  const cfg = agents[id];
  if (!cfg) throw new Error(`agent '${id}' not found`);
  if (!isSafeBotId(id)) {
    throw new Error(`agent id '${id}' cannot host a runtime profile`);
  }
  const duyaRoot = store.getConfigDir();
  const profilePath = getBotProfilePath(id, duyaRoot);
  const existing = readBotProfile(profilePath);
  if (!existing) return null;
  deleteBotAvatarImageFile(id, existing.avatarImage, duyaRoot);
  return writeBotProfile(profilePath, {
    name: existing.name || cfg.name || id,
    title: existing.title,
    description: existing.description,
    avatarColor: undefined,
    avatarImage: undefined,
  });
}

/**
 * Delete a bot's avatar image file (best-effort). Caller has already
 * validated the filename shape; a missing file is not an error.
 */
function deleteBotAvatarImageFile(id: string, avatarImage: string | undefined, duyaRoot: string): void {
  if (!avatarImage || !isValidAvatarImageFilename(avatarImage)) return;
  try {
    fs.rmSync(getBotAvatarFilePath(id, avatarImage, duyaRoot), { force: true });
  } catch {
    // Best-effort: the profile no longer references it either way.
  }
}

/** Result of a successful avatar image upload / clear. */
export interface BotAvatarImageResult {
  /** Stored filename inside the agent directory (e.g. `avatar.png`). */
  avatarImage: string;
  /** mtime (ms) of the stored file; 0 after a clear. */
  avatarVersion: number;
  /** `duya-file://` URL with cache-buster; absent after a clear. */
  avatarUrl?: string;
}

/**
 * Install an avatar image for a bot: validate, copy into the bot's agent
 * directory as `avatar.<ext>` (replacing any previous avatar file), and
 * record the filename in profile.json. `sourcePath` is an absolute path to
 * an already-on-disk image — either the user's picked file (UI upload IPC)
 * or a file the model itself produced (update_state avatar.set +
 * ImageGenerateTool output). Throws on validation failure; callers map
 * errors to their own surface (IPC error / structured RPC code).
 */
export function setBotAvatarImage(id: string, sourcePath: string): BotAvatarImageResult {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  if (!agents[id]) throw new Error(`agent '${id}' not found`);
  if (!isSafeBotId(id)) {
    throw new Error(`agent id '${id}' cannot host a runtime profile`);
  }
  const ext = avatarSourceExtension(path.basename(sourcePath));
  if (!ext) {
    throw new Error(
      `Unsupported avatar file: expected avatar.(png|jpg|jpeg|webp|gif|svg) source, got '${path.basename(sourcePath)}'`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    throw new Error(`Avatar source file not found: '${sourcePath}'`);
  }
  if (!stat.isFile()) throw new Error(`Avatar source is not a file: '${sourcePath}'`);
  if (stat.size > BOT_AVATAR_MAX_BYTES) {
    throw new Error(`Avatar file too large (${stat.size} bytes; limit ${BOT_AVATAR_MAX_BYTES})`);
  }
  const buf = fs.readFileSync(sourcePath);
  sniffAvatarMagic(buf, ext, sourcePath);

  const duyaRoot = store.getConfigDir();
  const filename = `avatar.${ext}`;
  const targetPath = getBotAvatarFilePath(id, filename, duyaRoot);
  const profilePath = getBotProfilePath(id, duyaRoot);
  const existing = readBotProfile(profilePath);

  // Remove a previous avatar stored under a different extension.
  if (existing?.avatarImage && existing.avatarImage !== filename) {
    deleteBotAvatarImageFile(id, existing.avatarImage, duyaRoot);
  }
  fs.mkdirSync(resolveDuyaAgentDir(id, duyaRoot), { recursive: true });
  fs.writeFileSync(targetPath, buf);

  writeBotProfile(profilePath, {
    name: existing?.name || agents[id].name || id,
    title: existing?.title ?? '',
    description: existing?.description ?? agents[id].description ?? '',
    avatarColor: existing?.avatarColor,
    avatarImage: filename,
  });
  const mtime = fs.statSync(targetPath).mtimeMs;
  return {
    avatarImage: filename,
    avatarVersion: mtime,
    avatarUrl: `duya-file:///${targetPath.replace(/\\/g, '/')}?v=${mtime}`,
  };
}

/**
 * Verify the first bytes of an uploaded avatar match its claimed extension.
 * SVG is text-based — accepted when it starts with an XML declaration or an
 * `<svg` tag. Everything else must match its binary magic number.
 */
function sniffAvatarMagic(buf: Buffer, ext: string, sourcePath: string): void {
  const ok =
    (ext === 'png' && buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) ||
    (ext === 'jpg' && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (ext === 'jpeg' && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (ext === 'gif' && buf.length >= 6 && buf.toString('latin1', 0, 6) === 'GIF8') ||
    (ext === 'webp' &&
      buf.length >= 12 &&
      buf.toString('latin1', 0, 4) === 'RIFF' &&
      buf.toString('latin1', 8, 12) === 'WEBP') ||
    (ext === 'svg' && matchesSvgText(buf));
  if (!ok) {
    throw new Error(`Avatar file content does not match its .${ext} extension: '${sourcePath}'`);
  }
}

function matchesSvgText(buf: Buffer): boolean {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 256)).trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg');
}

/**
 * Remove a bot's avatar image: delete the file and drop the profile
 * field. The color token (if any) is left untouched — clearing the image
 * falls the avatar back to the colored initial circle.
 */
export function clearBotAvatarImage(id: string): BotAvatarImageResult {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  if (!agents[id]) throw new Error(`agent '${id}' not found`);
  if (!isSafeBotId(id)) {
    throw new Error(`agent id '${id}' cannot host a runtime profile`);
  }
  const duyaRoot = store.getConfigDir();
  const profilePath = getBotProfilePath(id, duyaRoot);
  const existing = readBotProfile(profilePath);
  if (!existing) {
    return { avatarImage: '', avatarVersion: 0 };
  }
  deleteBotAvatarImageFile(id, existing.avatarImage, duyaRoot);
  writeBotProfile(profilePath, {
    name: existing.name || agents[id].name || id,
    title: existing.title,
    description: existing.description,
    avatarColor: existing.avatarColor,
    avatarEmoji: existing.avatarEmoji,
    avatarImage: undefined,
  });
  return { avatarImage: '', avatarVersion: 0 };
}
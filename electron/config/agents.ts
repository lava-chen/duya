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
 */
import fs from 'fs';
import type { CustomAgentConfig } from './schema.js';
import { getConfigStore } from './store-instance.js';
import { isSafeBotId } from './agent-id.js';
import { getBotProfilePath } from './agent-paths.js';
import { readBotProfile, writeBotProfile, type BotProfile, type BotProfileInput } from './bot-profile.js';

export interface AgentUpsertInput {
  name: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
  /** grok-style avatar tokens, seeded into `agents/<id>/profile.json` on first creation. */
  avatarShape?: string;
  avatarColor?: string;
}

export function listConfigAgents(): Record<string, CustomAgentConfig> {
  const store = getConfigStore();
  return (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
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
  workspace?: string;
  avatarShape?: string;
  avatarColor?: string;
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
      workspace: cfg.workspace,
      avatarShape: profile?.avatarShape,
      avatarColor: profile?.avatarColor,
    });
  }
  return out;
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
  const next: CustomAgentConfig = {
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    model: input.model?.trim() || undefined,
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
    seedBotProfileIfMissing(id, next, store, input.avatarShape, input.avatarColor);
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
  avatarShape?: string,
  avatarColor?: string,
): void {
  if (!isSafeBotId(id)) return;
  try {
    const profilePath = getBotProfilePath(id, store.getConfigDir());
    if (fs.existsSync(profilePath)) return;
    writeBotProfile(profilePath, {
      name: entry.name || id,
      title: '',
      description: entry.description ?? '',
      avatarShape: avatarShape?.trim() || undefined,
      avatarColor: avatarColor?.trim() || undefined,
    });
  } catch (err) {
    // Best-effort: logging infra may not be wired in all callers yet.
    // eslint-disable-next-line no-console
    console.warn(`[config-agents] failed to seed profile for '${id}':`, err);
  }
}

export function deleteConfigAgent(id: string): boolean {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  if (!(id in agents)) return false;
  delete agents[id];
  store.set('agents', agents);
  return true;
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
  avatarShape?: string;
  avatarColor?: string;
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
    avatarShape: input.avatarShape?.trim() || existing?.avatarShape,
    avatarColor: input.avatarColor?.trim() || existing?.avatarColor,
  };
  return writeBotProfile(profilePath, next);
}
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
import { writeBotProfile } from './bot-profile.js';

export interface AgentUpsertInput {
  name: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
}

export function listConfigAgents(): Record<string, CustomAgentConfig> {
  const store = getConfigStore();
  return (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
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
  };
  agents[id] = next;
  store.set('agents', agents);
  if (isNewAgent) {
    seedBotProfileIfMissing(id, next, store);
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
): void {
  if (!isSafeBotId(id)) return;
  try {
    const profilePath = getBotProfilePath(id, store.getConfigDir());
    if (fs.existsSync(profilePath)) return;
    writeBotProfile(profilePath, {
      name: entry.name || id,
      title: '',
      description: entry.description ?? '',
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
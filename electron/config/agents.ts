/**
 * Shared config-agents write module (custom agent creation).
 * Mutates ConfigStore `agents` map and persists via the store.
 * Single write path for form (IPC) and CLI (HTTP route).
 */
import type { CustomAgentConfig } from './schema.js';
import { getConfigStore } from './store-instance.js';

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
  return next;
}

export function deleteConfigAgent(id: string): boolean {
  const store = getConfigStore();
  const agents = (store.getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
  if (!(id in agents)) return false;
  delete agents[id];
  store.set('agents', agents);
  return true;
}
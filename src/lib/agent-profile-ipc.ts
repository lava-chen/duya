/**
 * Agent Profile IPC Client
 * Wrapper for agent profile database operations
 */

export type AgentProfileKind = 'main' | 'subagent' | 'special';

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  defaultModel?: string;
  /** Structural grouping: 'main' = user-facing main agents, others internal */
  kind: AgentProfileKind;
  userVisible: boolean;
  isPreset: boolean;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RawAgentProfile {
  id: string;
  name: string;
  description?: string;
  allowed_tools?: string;
  disallowed_tools?: string;
  default_model?: string;
  profile_kind?: string;
  user_visible?: number;
  is_preset?: number;
  is_enabled?: number;
  created_at?: number;
  updated_at?: number;
}

function parseAgentProfile(raw: RawAgentProfile): AgentProfile {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    allowedTools: raw.allowed_tools ? JSON.parse(raw.allowed_tools) : undefined,
    disallowedTools: raw.disallowed_tools ? JSON.parse(raw.disallowed_tools) : undefined,
    defaultModel: raw.default_model,
    kind: (raw.profile_kind as AgentProfileKind) ?? 'main',
    userVisible: raw.user_visible === 1,
    isPreset: raw.is_preset === 1,
    isEnabled: raw.is_enabled !== 0,
    createdAt: raw.created_at || 0,
    updatedAt: raw.updated_at || 0,
  };
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const raw = await window.electronAPI.agentProfile.list() as RawAgentProfile[];
  return raw.map(parseAgentProfile);
}

export interface CustomAgentConfig {
  name?: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
}

/** Config-driven custom agents ([agents.<id>] in config.toml). */
export async function listCustomAgents(): Promise<Record<string, CustomAgentConfig>> {
  return window.electronAPI.configAgents.list() as Promise<Record<string, CustomAgentConfig>>;
}

/** Input shape for create/update config agent (mirrors electron CustomAgentConfig). */
export type AgentUpsertInput = {
  name: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
};

export async function createConfigAgent(id: string, input: AgentUpsertInput): Promise<void> {
  await window.electronAPI.configAgents.create(id, input);
}
export async function updateConfigAgent(id: string, input: AgentUpsertInput): Promise<void> {
  await window.electronAPI.configAgents.update(id, input);
}
export async function deleteConfigAgent(id: string): Promise<boolean> {
  return window.electronAPI.configAgents.delete(id);
}

/** Merge config custom agents into an AgentProfile-shaped list (kind='main'). */
export async function listMainAgentProfiles(): Promise<AgentProfile[]> {
  const [dbProfiles, customAgents] = await Promise.all([listAgentProfiles(), listCustomAgents()]);
  const main = dbProfiles.filter((p) => p.kind === 'main');
  const custom: AgentProfile[] = Object.entries(customAgents).map(([id, c]) => ({
    id,
    name: c.name || id,
    description: c.description,
    allowedTools: c.tools?.allow,
    disallowedTools: [...(c.tools?.deny ?? [])],
    defaultModel: c.model,
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  }));
  return [...main, ...custom];
}

export async function getAgentProfile(id: string): Promise<AgentProfile | null> {
  const raw = await window.electronAPI.agentProfile.get(id) as RawAgentProfile | null;
  return raw ? parseAgentProfile(raw) : null;
}

export async function createAgentProfile(data: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentProfile> {
  return window.electronAPI.agentProfile.create(data) as Promise<AgentProfile>;
}

export async function updateAgentProfile(id: string, data: Partial<AgentProfile>): Promise<AgentProfile> {
  return window.electronAPI.agentProfile.update(id, data) as Promise<AgentProfile>;
}

export async function deleteAgentProfile(id: string): Promise<boolean> {
  return window.electronAPI.agentProfile.delete(id);
}

export async function setSessionAgentProfile(sessionId: string, agentProfileId: string | null): Promise<void> {
  return window.electronAPI.thread.update(sessionId, { agent_profile_id: agentProfileId }) as Promise<void>;
}

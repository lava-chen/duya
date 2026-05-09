/**
 * Agent Profile IPC Client
 * Wrapper for agent profile database operations
 */

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  defaultModel?: string;
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

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
  /** Section gating (PromptProfileOverride) — persisted across reloads (Plan 420). */
  promptProfile?: { enableSections?: string[]; disableSections?: string[] };
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
  prompt_profile?: string;
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
    promptProfile: raw.prompt_profile ? JSON.parse(raw.prompt_profile) : undefined,
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
  /** Provider store id the `model` belongs to. */
  provider?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
}

/** Config-driven custom agents ([agents.<id>] in config.toml). */
export async function listCustomAgents(): Promise<Record<string, CustomAgentConfig>> {
  return window.electronAPI.configAgents.list() as Promise<Record<string, CustomAgentConfig>>;
}

/** One bot in the sidebar Bots section (mirrors electron `BotListItem` in electron/config/agents.ts). */
export interface BotListItem {
  id: string;
  /** Display identity — profile name wins, else config name, else the id. */
  name: string;
  /** Role subtitle (profile.json only). */
  title: string;
  description: string;
  model?: string;
  /** Provider store id the configured `model` belongs to. */
  provider?: string;
  workspace?: string;
  avatarColor?: string;
  /** `duya-file://` URL of the bot's avatar image (main-process built). */
  avatarUrl?: string;
}

/** Merge config + profile.json for bot agents (Plan 483 grok-style bot management). */
export async function listBots(): Promise<BotListItem[]> {
  return window.electronAPI.configAgents.listBots() as Promise<BotListItem[]>;
}

/** Input shape for create/update config agent (mirrors electron AgentUpsertInput). */
export type AgentUpsertInput = {
  name: string;
  description?: string;
  /** Role subtitle — profile.json ONLY (485 §2.4), seeded on first creation. */
  title?: string;
  model?: string;
  /** Provider store id the `model` belongs to. Absent → preserve the existing value. */
  provider?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
  /** Color token for the initial-circle avatar, seeded into `agents/<id>/profile.json` on first creation. */
  avatarColor?: string;
  /** User-picked emoji for the colored circle, seeded into `agents/<id>/profile.json` on first creation. */
  avatarEmoji?: string;
};

export interface CreateConfigAgentResult {
  /** Actual id after main-process collision allocation (may differ from the requested id). */
  id: string;
}

/**
 * Create a config agent. `id` is a HINT: pass '' and the main process mints
 * one from the display name (single minting point, grok agent-session.ts
 * parity — ids are never user-authored); a non-empty id is honored verbatim
 * when free or suffixed when taken. The returned id is always the ACTUAL id.
 */
export async function createConfigAgent(id: string, input: AgentUpsertInput): Promise<CreateConfigAgentResult> {
  const result = (await window.electronAPI.configAgents.create(id, input)) as { id?: string } | null;
  return { id: result?.id ?? id };
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

/** Plan 483 P2: update a bot's display identity from the sidebar edit dialog.
 *  Writes to `agents/<id>/profile.json` via the `config:agents:updateBotProfile` IPC.
 */
export interface BotIdentityUpdateInput {
  name?: string;
  title?: string;
  description?: string;
  avatarColor?: string;
  avatarEmoji?: string;
}

export async function updateBotIdentity(id: string, input: BotIdentityUpdateInput): Promise<void> {
  await window.electronAPI.configAgents.updateBotProfile(id, input as unknown as Record<string, unknown>);
}

/** Upload an avatar image for a bot (file dialog opens in the main process). */
export async function uploadBotAvatar(id: string): Promise<{
  avatarImage: string;
  avatarVersion: number;
  avatarUrl?: string;
} | null> {
  return window.electronAPI.configAgents.uploadBotAvatar(id);
}

/** Remove a bot's avatar image; the color circle (if configured) takes over. */
export async function clearBotAvatar(id: string): Promise<void> {
  await window.electronAPI.configAgents.clearBotAvatar(id);
}

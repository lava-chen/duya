/**
 * Config-driven custom agent profiles (Plan 424).
 * Builds an `AgentProfile` descriptor for the runtime from Host-owned config.
 */
import { readFile } from 'node:fs/promises';
import type { AgentProfile } from '@duya/agent-core';
import { applyBotToolset } from './bot-toolset.js';
import { resolveAgentConfig, type CustomAgentConfig } from '@duya/host/agent-profile-config';

export {
  readConfigAgents,
  resolveAgentConfig,
  resolveConfigRoot,
} from '@duya/host/agent-profile-config';
export type {
  CustomAgentConfig,
  CustomAgentPromptConfig,
  CustomAgentPromptIdentityConfig,
  CustomAgentPromptSectionsConfig,
  CustomAgentToolsConfig,
} from '@duya/host/agent-profile-config';

/** Base tool profiles -> allow/deny pattern lists (subset of legacy tool_profiles). */
const TOOL_PROFILE_MAP: Record<string, { allow: string[]; deny: string[] }> = {
  full: { allow: ['*'], deny: [] },
  coding: { allow: ['file:*', 'search:*', 'exec:*', 'process:*', 'git:*'], deny: ['browser:*', 'gateway:*'] },
  minimal: { allow: ['read', 'glob', 'grep', 'search:*'], deny: ['write', 'edit', 'exec:*', 'browser:*', 'gateway:*'] },
  research: { allow: ['file:read*', 'search:*', 'browser:*'], deny: ['file:write*', 'file:edit*', 'exec:*'] },
};

/** Build an `AgentProfile` descriptor from a config entry. */
export async function toAgentProfile(id: string, entry: CustomAgentConfig): Promise<AgentProfile> {
  const resolved = resolveAgentConfig(id, entry);
  const tools = entry.tools ?? {};
  const base = TOOL_PROFILE_MAP[tools.profile ?? 'full'] ?? TOOL_PROFILE_MAP.full;
  const allow = tools.allow && tools.allow.length ? tools.allow : base.allow;
  const deny = [...base.deny, ...(tools.deny ?? [])];

  // Plan 481 P1.2: every bot profile gets the bot collaboration toolset on
  // top of its base profile (no-op for '*' allowlists). Explicit denies in
  // [agents.<id>.tools] still win downstream — ToolFilter applies after.
  let globalInstructions: string | undefined;
    try {
      globalInstructions = resolved.agents_md ? await readFile(resolved.agents_md, 'utf8') : undefined;
    } catch {
      // missing file is fine — no agent global instructions
    }

  const profile: AgentProfile = {
    id,
    name: entry.name || id,
    description: entry.description,
    allowedTools: allow,
    disallowedTools: deny,
    defaultModel: entry.model,
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    globalInstructions,
    createdAt: 0,
    updatedAt: 0,
  };
  return applyBotToolset(profile);
}

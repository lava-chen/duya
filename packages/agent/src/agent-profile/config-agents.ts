/**
 * Config-driven custom agent profiles (Plan 424).
 * Reads `~/.duya/config.toml` -> `[agents.<id>]` and builds an `AgentProfile`
 * descriptor for the runtime. Mirrors `readUserMcpToml` (mcp/config.ts): the
 * worker reads config.toml directly, no main-process round trip.
 */
import * as os from 'os';
import * as path from 'path';
import { readFile } from 'fs/promises';
import { parse as parseToml } from '@iarna/toml';
import type { AgentProfile } from './types.js';
import { applyBotToolset } from './bot-toolset.js';

export interface CustomAgentToolsConfig {
  profile?: string;
  allow?: string[];
  deny?: string[];
}

/** Plan 474 §2.4: structured prompt persona — overrides the registry
 *  fallback for prompt rendering only (runtime profile.json still wins). */
export interface CustomAgentPromptIdentityConfig {
  name?: string;
  description?: string;
  /** How the bot speaks (tone/style hint rendered by the botIdentity section). */
  voice?: string;
}

/** Plan 474 §2.4: section gating. Unknown section names are ignored
 *  (forward compatible with sections landing via 476/479/481). */
export interface CustomAgentPromptSectionsConfig {
  /** Whitelist: when non-empty, only these registered sections render. */
  enable?: string[];
  /** Blacklist: these sections never render; wins over enable. */
  disable?: string[];
}

/** Plan 474 §2.4: `[agents.<id>.prompt]` table. */
export interface CustomAgentPromptConfig {
  sections?: CustomAgentPromptSectionsConfig;
  identity?: CustomAgentPromptIdentityConfig;
}

export interface CustomAgentConfig {
  name?: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: CustomAgentToolsConfig;
  plugins?: string[];
  /** Bot system-prompt section config (Plan 474 P3.2). */
  prompt?: CustomAgentPromptConfig;
}

/** Base tool profiles -> allow/deny pattern lists (subset of legacy tool_profiles). */
const TOOL_PROFILE_MAP: Record<string, { allow: string[]; deny: string[] }> = {
  full: { allow: ['*'], deny: [] },
  coding: { allow: ['file:*', 'search:*', 'exec:*', 'process:*', 'git:*'], deny: ['browser:*', 'gateway:*'] },
  minimal: { allow: ['read', 'glob', 'grep', 'search:*'], deny: ['write', 'edit', 'exec:*', 'browser:*', 'gateway:*'] },
  research: { allow: ['file:read*', 'search:*', 'browser:*'], deny: ['file:write*', 'file:edit*', 'exec:*'] },
};

/** Config root: ~/.duya (or test-namespaced dir under DUYA_TEST). Exported so
 *  sibling readers (bot profile.json, Plan 485 P2.2) resolve the same root. */
export function resolveConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

function expandPath(p: string | undefined, baseDir?: string): string | undefined {
  if (!p) return undefined;
  let out = p;
  if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] || '');
  if (baseDir && !path.isAbsolute(out)) out = path.resolve(baseDir, out);
  return out;
}

/** Read all config-driven custom agents from config.toml. */
export async function readConfigAgents(): Promise<Record<string, CustomAgentConfig>> {
  try {
    const filePath = path.join(resolveConfigRoot(), 'config.toml');
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseToml(raw) as { agents?: Record<string, unknown> };
    return (parsed.agents ?? {}) as Record<string, CustomAgentConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Resolve one config agent entry (expand paths). */
export function resolveAgentConfig(id: string, entry: CustomAgentConfig): CustomAgentConfig {
  return {
    ...entry,
    workspace: expandPath(entry.workspace) ?? expandPath(process.env.DUYA_DEFAULT_WORKSPACE) ?? path.join(os.homedir(), '.duya', 'workspace'),
    agents_md: expandPath(entry.agents_md) ?? (entry.workspace ? path.join(expandPath(entry.workspace)!, 'AGENTS.md') : undefined),
  };
}

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
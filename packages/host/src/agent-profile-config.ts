import * as os from 'node:os';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseToml } from '@iarna/toml';
import { resolveDataRoot } from '@duya/data/data-paths';
import type { CustomAgentConfig } from './config-agents/agent-config-schema.js';

export type {
  CustomAgentConfig,
  CustomAgentPromptConfig,
  CustomAgentPromptIdentityConfig,
  CustomAgentPromptSectionsConfig,
  CustomAgentToolsConfig,
} from './config-agents/agent-config-schema.js';

/** Resolve the shared user configuration root without depending on Electron. */
export function resolveConfigRoot(): string {
  return resolveDataRoot();
}

/** Read config-driven agent definitions from the Host-owned config root. */
export async function readConfigAgents(): Promise<Record<string, CustomAgentConfig>> {
  try {
    const filePath = path.join(resolveConfigRoot(), 'config.toml');
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseToml(raw) as { agents?: Record<string, unknown> };
    return (parsed.agents ?? {}) as Record<string, CustomAgentConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Resolve configured workspace and instruction paths against the user environment. */
export function resolveAgentConfig(_id: string, entry: CustomAgentConfig): CustomAgentConfig {
  const agentsMd =
    expandPath(entry.agents_md) ??
    (entry.workspace ? path.join(expandPath(entry.workspace)!, 'AGENTS.md') : undefined);
  return {
    ...entry,
    workspace:
      expandPath(entry.workspace) ??
      expandPath(process.env.DUYA_DEFAULT_WORKSPACE) ??
      path.join(resolveConfigRoot(), 'workspace'),
    ...(agentsMd === undefined ? {} : { agents_md: agentsMd }),
  };
}

function expandPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let expanded = value;
  if (expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(2));
  expanded = expanded.replace(/\$\{(\w+)\}/g, (_match, name: string) => process.env[name] || '');
  return expanded;
}

/**
 * config-agents-api.ts — the config write side for custom agents.
 *
 * The Desktop config store owns the in-memory copy of `config.toml`; the
 * standalone Host has no such store, so it writes the file itself. Both
 * writers share the rules (see `agent-config-core.ts`) and differ only in the
 * storage backend.
 *
 * The Host side therefore:
 *   1. reads `config.toml` fresh (never from a stale snapshot),
 *   2. changes ONLY the `[agents]` table,
 *   3. writes the whole document back atomically.
 *
 * Every other table — providers, hooks, mcp_servers, storage — is parsed and
 * written back unchanged, so a config-agent write can never drop a provider.
 *
 * ## Why the agent tool path may not do this itself
 *
 * `@duya/capabilities`'s permission policy refuses an agent's Write / Edit /
 * Shell tools on `~/.duya/config.toml`, because the config store is the
 * single writer. That refusal is about the *tool* path, not about the Host
 * process: the worker reaches this module through the db bridge, which is
 * exactly the serialization point the Desktop uses.
 */

import * as path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';
import {
  allocateBotId,
  buildUpsertedAgent,
  isSoftDeletedConfigAgent,
  mergeTakenBotIds,
  seedBotProfileIfMissing,
  slugifyBotIdFromName,
} from './agent-config-core.js';
import {
  readAgentsTable,
  readConfigTomlDocument,
  writeConfigAgentsTable,
} from './config-file.js';
import type { AgentIdentityPatch } from './agent-config-schema.js';

/** Minimal logger surface — the Host's bridge passes its own. */
export interface ConfigAgentsLogger {
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
}

export interface ConfigAgentsWriteOptions {
  /** Directory holding `config.toml`. Defaults to the shared data root. */
  root?: string | undefined;
  logger?: ConfigAgentsLogger | undefined;
}

/** The identity a caller gets back after a create / update. */
export interface ConfigAgentIdentity {
  id: string;
  name: string;
}

/**
 * Create an agent from a display name.
 *
 * The id is derived from the name (slug) and made collision-free against the
 * config keys, the on-disk agent trees and the soft-delete tombstones, so a
 * new agent can never inherit a deleted bot's directory. The returned `id` is
 * the ACTUAL id — it carries a `-<6 hex>` suffix when the slug was taken.
 */
export async function createConfigAgent(
  name: string,
  description?: string,
  options: ConfigAgentsWriteOptions = {},
): Promise<ConfigAgentIdentity> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('agent name is required');
  const root = options.root ?? resolveDataRoot();
  const configPath = path.join(root, 'config.toml');

  const doc = await readConfigTomlDocument(configPath);
  const agents = readAgentsTable(doc);
  const taken = mergeTakenBotIds(Object.keys(agents), root);
  const id = allocateBotId(slugifyBotIdFromName(trimmed), taken);
  const next = buildUpsertedAgent(undefined, {
    name: trimmed,
    description: description?.trim() || undefined,
  });

  await writeConfigAgentsTable(configPath, { ...agents, [id]: next });

  // Best-effort: the profile seeds the runtime identity on first creation.
  // A failure here must not fail the config write.
  seedBotProfileIfMissing(root, id, next, {
    onError: (error) => {
      options.logger?.warn?.('Failed to seed agent profile', {
        agentId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  options.logger?.info?.('Agent created via the config write side', { agentId: id });
  return { id, name: next.name ?? id };
}

/**
 * Patch an agent's identity (name / description).
 *
 * Only the provided fields change; model / provider / reasoning / workspace /
 * tools / plugins / prompt table are preserved exactly. Throws when the id is
 * unknown, and when the agent is soft-deleted (a soft-deleted entry must be
 * restored or purged, never silently resurrected).
 */
export async function updateConfigAgentIdentity(
  agentId: string,
  patch: AgentIdentityPatch,
  options: ConfigAgentsWriteOptions = {},
): Promise<ConfigAgentIdentity> {
  const root = options.root ?? resolveDataRoot();
  const configPath = path.join(root, 'config.toml');

  const doc = await readConfigTomlDocument(configPath);
  const agents = readAgentsTable(doc);
  const existing = agents[agentId];
  if (!existing) throw new Error(`agent '${agentId}' not found`);
  if (isSoftDeletedConfigAgent(existing)) {
    throw new Error(`agent '${agentId}' is soft-deleted; restore or purge it before re-creating`);
  }

  const next = buildUpsertedAgent(existing, {
    name:
      patch.name !== undefined && patch.name.trim()
        ? patch.name.trim()
        : existing.name ?? agentId,
    description:
      patch.description !== undefined && patch.description.trim()
        ? patch.description.trim()
        : existing.description,
    model: existing.model,
    workspace: existing.workspace,
    agents_md: existing.agents_md,
    tools: existing.tools,
    plugins: existing.plugins,
  });

  await writeConfigAgentsTable(configPath, { ...agents, [agentId]: next });
  options.logger?.info?.('Agent updated via the config write side', { agentId });
  return { id: agentId, name: next.name ?? agentId };
}

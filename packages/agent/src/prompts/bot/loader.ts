/**
 * Bot context loader — wires the config-driven bot data (Plan 424 read
 * side) into a BotPromptContext for the prompt assembly.
 *
 * Data source precedence (Plan 485 P2.2): `~/.duya/agents/<id>/profile.json`
 * (runtime identity, written by the Electron main / update_state) first,
 * then `~/.duya/config.toml` -> `[agents.<id>]` (declaration fallback).
 * Both are read directly by the worker (no main round trip — same pattern
 * as `readConfigAgents()`).
 */

import * as path from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { readConfigAgents } from '../../agent-profile/config-agents.js'
import { listResolvedGroups } from '../../agent-profile/config-groups.js'
import { readBotProfileIdentity } from '../../agent-profile/bot-profile-reader.js'
import type { CustomAgentPromptConfig } from '../../agent-profile/config-agents.js'
import type { AgentProfile } from '../../agent-profile/types.js'
import { getDuyaRoot } from '../../memory-state/memory_paths.js'
import type { BotPromptConfig, BotPromptContext, BotRosterEntry } from './framework.js'
import {
  readJoinedProjects,
  readOwnTierEntries,
  readProjectTierEntries,
  readUserTierEntries,
} from './memory/tierReader.js'
import type { BotMemoryContext } from './memory/types.js'
import type { ChannelSnapshot } from '../../channels/types.js'

/**
 * Is this profile a config-driven bot? A "bot" session is one running a
 * custom agent declared under `[agents.<id>]` in config.toml (Plan 424):
 * built-in presets (general/code/research/gateway/cron) are all
 * `isPreset: true`, whereas config agents are produced with
 * `isPreset: false` and `kind: 'main'` (see config-agents.ts
 * `toAgentProfile`). The tail append in DuyaAgent._buildSystemPrompt uses
 * this predicate to decide whether to inject bot sections at all.
 */
export function isBotAgentProfile(profile?: AgentProfile): boolean {
  if (!profile) return false
  if (profile.isPreset) return false
  // Config agents resolve to kind 'main'; guard the other kinds defensively
  // (subagent/special infrastructure profiles are never bots).
  return profile.kind === 'main' || profile.kind === undefined
}

/**
 * Defensively narrow the raw `[agents.<id>.prompt]` table (Plan 474 §2.4)
 * into the prompt-layer shape. The toml parser yields arbitrary structures;
 * unknown keys are dropped, wrong-typed values become undefined, and empty
 * arrays are preserved (an empty enable list means "no whitelist").
 */
function sanitizePromptConfig(raw: CustomAgentPromptConfig | undefined): BotPromptConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: BotPromptConfig = {}

  const sections = raw.sections
  if (sections && typeof sections === 'object') {
    const asStringArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
    const enable = asStringArray(sections.enable)
    const disable = asStringArray(sections.disable)
    if (enable || disable) out.sections = { enable, disable }
  }

  const identity = raw.identity
  if (identity && typeof identity === 'object') {
    const asString = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v : undefined
    const name = asString(identity.name)
    const description = asString(identity.description)
    const voice = asString(identity.voice)
    if (name || description || voice) out.identity = { name, description, voice }
  }

  return out.sections || out.identity ? out : undefined
}

/** Resolve one roster row's display name/description (profile first). */

/**
 * Build a BotPromptContext for the bot identified by `agentId`.
 * Self identity (botAgentId/botName/botDescription) and the agent directory
 * (other bots) prefer profile.json and fall back to `[agents.<id>]` config.
 *
 * When the bot id is unknown and there is no profile/config entry, returns a
 * minimal context ({}) — all renderers then omit themselves and only the
 * basic prompt is emitted.
 */
export async function loadBotPromptContext(agentId?: string): Promise<BotPromptContext> {
  if (!agentId) return {}

  // Self identity: profile.json wins over config declaration.
  const agents = await readConfigAgents()
  const configSelf = agents[agentId]
  const profileSelf = await readBotProfileIdentity(agentId)
  // Plan 474 P3.2: `[agents.<id>.prompt]` structured prompt config.
  const promptConfig = sanitizePromptConfig(configSelf?.prompt)

  // Identity precedence for prompt rendering: runtime profile.json (Plan
  // 485 P2.2, the model's current self-knowledge) > declared prompt
  // persona ([agents.<id>.prompt.identity]) > registry fallback
  // ([agents.<id>] top-level name/description).
  const botName =
    profileSelf?.name || promptConfig?.identity?.name || configSelf?.name || agentId
  const botDescription =
    profileSelf?.description ?? promptConfig?.identity?.description ?? configSelf?.description
  if (!profileSelf && !configSelf) {
    return { botAgentId: agentId }
  }

  const ctx: BotPromptContext = {
    botAgentId: agentId,
    botName,
    botDescription,
  }
  if (promptConfig) {
    ctx.promptConfig = promptConfig
    if (promptConfig.identity?.voice) ctx.voice = promptConfig.identity.voice
  }

  // Roster: other bots — profile first, config entry name as fallback.
  const otherIds = Object.keys(agents).filter((id) => id !== agentId)
  // Prefer reading from config map when present (avoids N profile probes for
  // bots that only exist in config), then let profile.json refine names.
  const roster = await Promise.all(
    otherIds.map(async (id) => {
      const entry = agents[id]
      const profile = await readBotProfileIdentity(id)
      if (profile) {
        return {
          id,
          name: profile.name || id,
          description: profile.description,
        }
      }
      return {
        id,
        name: entry.name || id,
        description: entry.description,
      }
    }),
  )
  if (roster.length > 0) {
    ctx.agentDirectory = roster
  }

  // Plan 478: shared rooms this bot belongs to (groups.toml read side) —
  // rendered by renderBotRoster inside the messaging contract.
  try {
    const groups = await listResolvedGroups()
    const memberGroups = Object.values(groups).filter((group) =>
      group.memberIds.includes(agentId),
    )
    if (memberGroups.length > 0) {
      ctx.agentGroups = memberGroups.map((group) => ({
        id: group.id,
        name: group.name,
        members: group.memberIds.map((id) => {
          const entry = agents[id]
          return {
            id,
            name: entry?.name || id,
            description: entry?.description,
          }
        }),
      }))
    }
  } catch {
    // groups.toml unreadable — the roster renders without rooms.
  }

  // Plan 479 P2.1: tiered memory from the file manifest. The duya root is
  // the memory root's parent; DUYA_MEMORY_ROOT overrides only the memory
  // tree, so derive the root from the memory root to stay override-safe.
  const memory = loadBotMemoryContext(
    agentId,
    new Map([[agentId, botName], ...roster.map((r) => [r.id, r.name] as const)]),
  )
  if (memory) ctx.memory = memory
  // 479 activation: absolute shard paths for the memoryUsage guidance
  // section, so the bot knows where its tiers live on disk.
  const duyaRoot = duyaRootForMemory()
  if (duyaRoot) {
    ctx.memoryRoots = {
      own: path.join(duyaRoot, 'agents', agentId, 'memory'),
      userShard: path.join(duyaRoot, 'agents', agentId, 'user'),
    }
  }
  // Plan 488 P2.4: read channel snapshots from agents/<agentId>/channels/
  const channels = await readAgentChannelSnapshots(agentId)
  if (channels.length > 0) ctx.channels = channels
  return ctx
}

/**
 * Read the three memory tiers from the file manifest and resolve
 * `[via <name>]` attribution through the roster. Returns null when all
 * tiers are empty — sections then omit themselves.
 */
export function loadBotMemoryContext(
  agentId: string,
  writerNames: Map<string, string>,
): BotMemoryContext | null {
  const duyaRoot = duyaRootForMemory()
  if (!duyaRoot) return null

  const own = readOwnTierEntries(duyaRoot, agentId)
  const user = readUserTierEntries(duyaRoot)
  const joinedProjects = readJoinedProjects(duyaRoot, agentId)
  const project = readProjectTierEntries(duyaRoot, joinedProjects)

  const withNames = (entries: BotMemoryContext['own']): BotMemoryContext['own'] =>
    entries.map((e) => ({
      ...e,
      writerName: e.writerId ? writerNames.get(e.writerId) ?? e.writerId : undefined,
    }))

  const memory: BotMemoryContext = {
    own: withNames(own),
    user: withNames(user),
    project: withNames(project),
    joinedProjects,
  }
  if (memory.own.length === 0 && memory.user.length === 0 && memory.project.length === 0) {
    return null
  }
  return memory
}

/**
 * Resolve the duya root for memory reads. `DUYA_MEMORY_ROOT` (test/alt-home
 * override) points at the memory tree, so the duya root is its parent;
 * otherwise the standard `~/.duya`.
 */
function duyaRootForMemory(): string | null {
  const override = process.env.DUYA_MEMORY_ROOT
  if (override) return path.dirname(override)
  return getDuyaRoot()
}
/**
 * Read channel snapshots for an agent from the file store (Plan 488 P2.4).
 *
 * Path: `~/.duya/agents/<agentId>/channels/<platform>/connection.json`
 *
 * Note: this reads connection.json but does NOT check for credentials
 * (connector-secrets) - that check requires the electron main process.
 * All returned channels have status 'configured' (connection exists).
 */
async function readAgentChannelSnapshots(agentId: string): Promise<ChannelSnapshot[]> {
  const duyaRoot = getDuyaRoot()
  if (!duyaRoot) return []

  const channelsDir = path.join(duyaRoot, 'agents', agentId, 'channels')

  let platforms: string[]
  try {
    platforms = await readdir(channelsDir)
  } catch {
    return []
  }

  const snapshots: ChannelSnapshot[] = []

  for (const platform of platforms) {
    // Skip hidden files/dirs and non-directories
    if (platform.startsWith('.')) continue

    const platformDir = path.join(channelsDir, platform)
    try {
      const statResult = await stat(platformDir)
      if (!statResult.isDirectory()) continue
    } catch {
      continue
    }

    // Read connection.json for this platform
    const configPath = path.join(platformDir, 'connection.json')
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'label' in parsed &&
        typeof (parsed as { label?: unknown }).label === 'string'
      ) {
        snapshots.push({
          platform,
          chat: '', // Chat ID resolved at delivery time
          label: (parsed as { label: string }).label,
          status: 'configured' as const,
        })
      }
    } catch {
      // Skip malformed or missing connection.json
    }
  }

  return snapshots
}

/**
 * cross-source.ts
 *
 * Plan 83b Phase 1B — read-only cross-source aggregation.
 *
 * Source of truth:
 *   - Skill: `packages/agent/src/skills/resolver.ts` (resolveAvailable,
 *     isWinnerEnabled, effectivePrecedenceOf). Phase 1B invokes these
 *     pure functions directly. We DO NOT call `skills:list` IPC, and
 *     we DO NOT call `syncBundledSkills` (which has side effects on
 *     `~/.duya/skills/`).
 *   - MCP: `electron/agents/mcp/collect-main.ts` (collectMainMCPCandidates)
 *     — the 4-source collector that merges plugin manifests, agentSettings,
 *     settingsKv, and the legacy file. We invoke the public function and
 *     select winners using the v0 precedence `settings > plugin > bundled`
 *     from `packages/agent/src/mcp/mcpService.ts:77`.
 *
 * Reuses:
 *   - `mcpService.computeMCPId` (= `idFor` re-export) for canonical MCP ids.
 *   - `getJsonSetting` for `skillEnabledOverrides`. We never mutate.
 *   - `scanSkillFile` from `packages/agent/src/security/skillScanner.ts`
 *     for `skill.securityVerdict` (read-only).
 *
 * Phase 1B does NOT:
 *   - call `skills:list` IPC
 *   - call `syncBundledSkills`
 *   - read `lastMCPLoadResult` (connection status stays `'unknown'`)
 *   - call `evaluateMcpToolPermission`
 *   - copy or rewrite any owner resolver / collector logic
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { getJsonSetting } from '../../db/queries/settings';
import { collectMainMCPCandidates } from '../../agents/mcp/collect-main';
import { readPluginManifest } from '../../plugins/manifest';
import { getPluginManager } from '../../plugins/PluginManager';

import {
  effectivePrecedenceOf,
  isWinnerEnabled,
  pickWinner,
  resolveAvailable,
  type AvailableSkill,
  type SkillCandidate,
} from '../../../packages/agent/src/skills/resolver.js';
import { scanSkillFile } from '../../../packages/agent/src/security/skillScanner.js';
import { computeMCPId } from '../../../packages/agent/src/mcp/mcpService.js';
import type { MCPCandidate } from '@duya/plugin-core';

import type {
  CapabilityDTO,
  CapabilityMcpFields,
  CapabilityMcpIssue,
  CapabilitySkillFields,
  PluginPackageDTO,
} from './types';

const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';
type SkillEnabledOverrides = Record<string, boolean>;

/**
 * Read skill enabled overrides from settingsKv. Pure read; does not
 * trigger any sync side effects.
 */
function readSkillEnabledOverrides(): SkillEnabledOverrides {
  try {
    return getJsonSetting<SkillEnabledOverrides>(SKILL_ENABLED_OVERRIDES_KEY, {});
  } catch {
    return {};
  }
}

/**
 * Walk a directory and list its subdirectory names.
 * Returns the empty array if the directory does not exist.
 */
function listSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/**
 * Read the SKILL.md markdown body for a skill, used by `scanSkillFile`.
 * Returns the empty string if the file is missing.
 */
function readSkillBody(dir: string): string {
  const candidate = join(dir, 'SKILL.md');
  if (!existsSync(candidate)) return '';
  try {
    return readFileSync(candidate, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Read a description from the SKILL.md frontmatter — best effort, never
 * throws. Returns undefined if the file has no recognizable description.
 */
function readSkillDescription(dir: string): string | undefined {
  const body = readSkillBody(dir);
  if (!body) return undefined;
  // Match a YAML-style `description:` key in the frontmatter. We do not
  // bring in a YAML parser for this — a small regex is sufficient and
  // keeps the function side-effect free.
  const match = /^description:\s*(.+)$/m.exec(body);
  return match ? match[1]!.trim() : undefined;
}

/**
 * Build a displayKey for a cross-source skill. We do NOT invent a stable
 * composite id per the user's principle: the React `key` is the
 * tuple `(name, origin, pluginId)`.
 */
function skillDisplayKey(skill: AvailableSkill): string {
  return `skill:${skill.origin}:${skill.pluginId ?? 'none'}:${skill.name}`;
}

function deriveSecurityVerdict(dir: string): {
  verdict: CapabilitySkillFields['securityVerdict'];
  findingCount: number;
} {
  const body = readSkillBody(dir);
  if (!body) return { verdict: 'unknown', findingCount: 0 };
  try {
    const findings = scanSkillFile(body, 'SKILL.md');
    if (findings.length === 0) return { verdict: 'safe', findingCount: 0 };
    const hasDanger = findings.some((f) => f.severity === 'dangerous');
    const hasCaution = findings.some((f) => f.severity === 'caution');
    if (hasDanger) return { verdict: 'dangerous', findingCount: findings.length };
    if (hasCaution) return { verdict: 'caution', findingCount: findings.length };
    return { verdict: 'safe', findingCount: findings.length };
  } catch {
    return { verdict: 'unknown', findingCount: 0 };
  }
}

export interface CrossSourceSkillOptions {
  bundledDir: string;
  userDir: string;
}

export function buildCrossSourceSkillCandidates(
  options: CrossSourceSkillOptions,
): { candidates: SkillCandidate[]; descriptions: Map<string, string> } {
  const candidates: SkillCandidate[] = [];
  const descriptions = new Map<string, string>();

  // Bundled: read from packages/agent/src/plugins/builtin/<name>/skills/<skill>
  for (const pluginDir of listSubdirectories(options.bundledDir)) {
    for (const skillName of listSubdirectories(join(options.bundledDir, pluginDir, 'skills'))) {
      candidates.push({
        name: skillName,
        origin: 'plugin',
        pluginId: pluginDir,
      });
      const desc = readSkillDescription(join(options.bundledDir, pluginDir, 'skills', skillName));
      if (desc) descriptions.set(skillName, desc);
    }
  }

  // User: read from ~/.duya/skills/<name>
  for (const userSkill of listSubdirectories(options.userDir)) {
    candidates.push({ name: userSkill, origin: 'user' });
    const desc = readSkillDescription(join(options.userDir, userSkill));
    if (desc) descriptions.set(userSkill, desc);
  }

  return { candidates, descriptions };
}

export interface CrossSourceSkillResult {
  capabilities: CapabilityDTO[];
  candidateCount: number;
  settingsOverrideApplied: boolean;
}

export function buildCrossSourceSkillCapabilities(
  options: CrossSourceSkillOptions,
): CrossSourceSkillResult {
  const overrides = readSkillEnabledOverrides();
  const { candidates, descriptions } = buildCrossSourceSkillCandidates(options);
  const available = resolveAvailable(candidates);
  const out: CapabilityDTO[] = [];

  for (const skill of available) {
    const ownEnabled = isWinnerEnabled(skill, overrides);
    const providerEnabled = skill.origin === 'plugin'
      ? (getPluginManager().listInstalled().find((p) => p.id === skill.pluginId)?.enabled ?? true)
      : true;
    const { effectiveEnabled, blockedReason } = computeEffective(ownEnabled, providerEnabled);

    // Security verdict: read the winner's on-disk SKILL.md.
    const winnerDir = skill.origin === 'user'
      ? join(options.userDir, skill.name)
      : skill.origin === 'plugin' && skill.pluginId
        ? join(options.bundledDir, skill.pluginId, 'skills', skill.name)
        : '';
    const verdict = winnerDir ? deriveSecurityVerdict(winnerDir) : { verdict: 'unknown' as const, findingCount: 0 };

    out.push({
      displayKey: skillDisplayKey(skill),
      kind: 'skill',
      name: skill.name,
      description: descriptions.get(skill.name),
      origin: skill.origin,
      providerPluginId: skill.pluginId,
      ownEnabled,
      providerEnabled,
      effectiveEnabled,
      blockedReason,
      skill: {
        securityVerdict: verdict.verdict,
        findingCount: verdict.findingCount,
      },
    });
  }

  return {
    capabilities: out,
    candidateCount: candidates.length,
    settingsOverrideApplied: Object.keys(overrides).length > 0,
  };
}

/**
 * Pick MCP winners from the collector output using the v0 precedence
 * `settings > plugin > bundled` from `mcpService.ts:77`.
 *
 * Returns the canonical-id-keyed winners and the original candidate count.
 */
export function pickMCPWinners(candidates: MCPCandidate[]): {
  winners: Array<{ candidate: MCPCandidate; id: string }>;
  totalCount: number;
} {
  const byName = new Map<string, MCPCandidate>();
  const PRECEDENCE: Record<string, number> = { settings: 3, plugin: 2, bundled: 1 };
  for (const c of candidates) {
    const existing = byName.get(c.rawConfig.name);
    if (!existing) {
      byName.set(c.rawConfig.name, c);
      continue;
    }
    const existingScore = PRECEDENCE[existing.source] ?? 0;
    const candidateScore = PRECEDENCE[c.source] ?? 0;
    if (candidateScore > existingScore) {
      byName.set(c.rawConfig.name, c);
    }
  }
  const winners: Array<{ candidate: MCPCandidate; id: string }> = [];
  for (const c of byName.values()) {
    const id = computeMCPId(c);
    winners.push({ candidate: c, id });
  }
  return { winners, totalCount: candidates.length };
}

export interface CrossSourceMCPResult {
  capabilities: CapabilityDTO[];
  candidateCount: number;
}

export async function buildCrossSourceMCPCapabilities(): Promise<CrossSourceMCPResult> {
  const collected = await collectMainMCPCandidates();
  const { winners, totalCount } = pickMCPWinners(collected.candidates);
  const issuesByName = new Map<string, NonNullable<typeof collected.issues>[number]>();
  for (const issue of collected.issues) {
    if (issue.serverName) {
      issuesByName.set(issue.serverName, issue);
    }
  }
  const out: CapabilityDTO[] = [];

  for (const { candidate, id } of winners) {
    const rawEnabled = (candidate.rawConfig as { enabled?: boolean }).enabled;
    const ownEnabled = rawEnabled !== false;
    const providerEnabled = candidate.source === 'plugin' && candidate.pluginId
      ? (getPluginManager().listInstalled().find((p) => p.id === candidate.pluginId)?.enabled ?? true)
      : true;
    const { effectiveEnabled, blockedReason } = computeEffective(ownEnabled, providerEnabled);

    // Phase 3: surface the most recent connection error from the
    // collector. We do NOT derive blockedReason from this issue —
    // Rev 3 修订 4 reserves blockedReason for configuration /
    // provider failures, not runtime connectivity.
    const lastIssue = issuesByName.get(candidate.rawConfig.name);
    const mcpFields: CapabilityMcpFields = {
      connectionStatus: lastIssue
        ? (lastIssue.phase === 'connection' ? 'error' : 'disconnected')
        : 'unknown',
    };
    if (lastIssue) {
      mcpFields.lastIssue = {
        phase: lastIssue.phase,
        humanMessage: lastIssue.humanMessage,
        severity: lastIssue.severity,
      };
    }

    out.push({
      displayKey: id,
      kind: 'mcp',
      name: candidate.rawConfig.name,
      origin: candidate.source === 'settings' ? 'settings' : candidate.source === 'plugin' ? 'plugin' : 'bundled',
      providerPluginId: candidate.pluginId,
      ownEnabled,
      providerEnabled,
      effectiveEnabled,
      blockedReason,
      mcp: mcpFields,
    });
  }

  return { capabilities: out, candidateCount: totalCount };
}

/**
 * Compute the (effectiveEnabled, blockedReason) pair.
 *
 * Phase 1B still does not derive `blockedReason` from connection errors
 * (Rev 3 修订 4). The two inputs are the configured ownEnabled and the
 * providerEnabled. The result is:
 *
 *   ownEnabled=false                → false, blockedReason='user-disabled'
 *   ownEnabled=true, provider=false → false, blockedReason='plugin-disabled'
 *   both true                       → true,  no blockedReason
 */
function computeEffective(
  ownEnabled: boolean,
  providerEnabled: boolean,
): { effectiveEnabled: boolean; blockedReason?: CapabilityDTO['blockedReason'] } {
  if (ownEnabled === false) {
    return { effectiveEnabled: false, blockedReason: 'user-disabled' };
  }
  if (providerEnabled === false) {
    return { effectiveEnabled: false, blockedReason: 'plugin-disabled' };
  }
  return { effectiveEnabled: true };
}

export interface AggregateBundledOptions {
  bundledDir: string;
}

/**
 * Aggregate plugin-declared skills that have NOT been enumerated by the
 * cross-source resolver. The cross-source resolver only knows about
 * plugin-declared skills that physically exist on disk under
 * `bundledDir`; if `manifest.capabilities.skills` lists a name that has
 * no on-disk file (e.g. a stub for a future release), we still surface
 * it from the manifest. This keeps the inventory complete.
 */
export function buildPluginDeclaredOnlySkills(
  plugins: PluginPackageDTO[],
  knownSkillNames: Set<string>,
): CapabilityDTO[] {
  const out: CapabilityDTO[] = [];
  for (const plugin of plugins) {
    // Look up the entry's install path through PluginManager — we
    // re-fetch the view to access installPath.
    const view = getPluginManager().listInstalled().find((p) => p.id === plugin.id);
    if (!view) continue;
    if (!existsSync(view.installPath)) continue;
    let manifest;
    try {
      manifest = readPluginManifest(view.installPath);
    } catch {
      continue;
    }
    const declared = manifest.capabilities?.skills ?? [];
    for (const skillName of declared) {
      if (knownSkillNames.has(skillName)) continue;
      const ownEnabled: boolean | null = null;
      const providerEnabled = plugin.enabled;
      const { effectiveEnabled, blockedReason } = providerEnabled
        ? { effectiveEnabled: null as boolean | null, blockedReason: undefined as CapabilityDTO['blockedReason'] | undefined }
        : { effectiveEnabled: false as boolean | null, blockedReason: 'plugin-disabled' as const };
      out.push({
        displayKey: `plugin:${plugin.id}:skill:${skillName}`,
        kind: 'skill',
        name: skillName,
        origin: 'plugin',
        providerPluginId: plugin.id,
        ownEnabled,
        providerEnabled,
        effectiveEnabled,
        blockedReason,
      });
    }
  }
  return out;
}

/**
 * Exported for testing — re-exports of the underlying resolver helpers
 * so unit tests can assert precedence without importing from the agent
 * package directly.
 */
export const _internal = {
  effectivePrecedenceOf,
  pickWinner,
};

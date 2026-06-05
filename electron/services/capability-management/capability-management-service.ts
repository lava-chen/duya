/**
 * capability-management-service.ts
 *
 * Plan 83b Phase 1A + Phase 1B — read-only aggregation of installed
 * plugins and their declared capabilities, plus cross-source
 * inventory for skills and MCPs.
 *
 * Rev 3 终版 4 处最终修订（重申）：
 *   1. ownEnabled nullable; effectiveEnabled 仅在 provider/own enabled
 *      状态可读时填 boolean
 *   2. enumerate 全部 installed (含 enabled=false)
 *   3. 共享 DTO 走 mirror 路径（见 ./types 与 src/lib/capability-management-types.ts）
 *   4. mcp.connectionStatus='unknown', mcp.lastIssue=undefined; blockedReason 不来自 connection
 *
 * 显式不做（Phase 1A + 1B 严格不进入）：
 *   - 不调 mcpService.toMCPListDTO / lastMCPLoadResult
 *   - 不调 evaluateMcpToolPermission
 *   - 不调 syncBundledSkills（写盘副作用）
 *   - 不调 skills:list IPC（间接触发 syncBundledSkills）
 *   - 不接 SSE 事件
 *   - 不复制 PluginManager 写盘
 */

import { homedir } from 'os';
import { join } from 'path';

import { getPluginManager } from '../../plugins/PluginManager';

import {
  buildCrossSourceMCPCapabilities,
  buildCrossSourceSkillCapabilities,
  buildPluginDeclaredOnlySkills,
} from './cross-source';
import { toPluginDeclaredCapabilities, toPluginPackageDTO } from './dto-mappers';
import type {
  CapabilityDTO,
  CapabilityManagementSnapshot,
  CapabilityManagementSnapshotPhase1B,
  CapabilityUnsupportedEntry,
  PluginPackageDTO,
} from './types';

const PHASE_1B_UNSUPPORTED: CapabilityUnsupportedEntry[] = [
  { kind: 'skill', reason: 'Phase 1B: cross-source enabled state is best-effort; user override + plugin enabled are derived' },
  { kind: 'mcp', reason: 'Phase 1B: connectionStatus still fixed at unknown; SSE not yet wired' },
];

export class CapabilityManagementService {
  /**
   * Build a read-only snapshot of all installed plugins and the
   * capabilities they declare in their on-disk manifest, plus
   * (Phase 1B) cross-source skill and MCP inventory.
   *
   * Enumeration covers ALL installed plugins (Rev 3 修订 2) — including
   * those whose `entry.enabled === false`.
   */
  async buildSnapshot(): Promise<CapabilityManagementSnapshotPhase1B> {
    const manager = getPluginManager();
    const installed = manager.listInstalled();

    const plugins: PluginPackageDTO[] = [];
    const capabilities: CapabilityDTO[] = [];

    // Iterate every installed entry, regardless of `enabled`.
    for (const view of installed) {
      plugins.push(toPluginPackageDTO(view));
      for (const cap of toPluginDeclaredCapabilities(view)) {
        capabilities.push(cap);
      }
    }

    // Phase 1B: cross-source inventory.
    const bundledDir = join(
      homedir(),
      '.duya',
      'agent-package',
      'plugins',
      'builtin',
    );
    const userSkillsDir = join(homedir(), '.duya', 'skills');

    const crossSkills = buildCrossSourceSkillCapabilities({
      bundledDir,
      userDir: userSkillsDir,
    });
    const crossMcp = await buildCrossSourceMCPCapabilities();

    capabilities.push(...crossSkills.capabilities);
    capabilities.push(...crossMcp.capabilities);

    // Re-emit plugin-declared skills that the cross-source resolver did
    // not pick up (e.g. stubs in the manifest with no on-disk file).
    const knownSkillNames = new Set(
      crossSkills.capabilities.map((c) => c.name),
    );
    capabilities.push(
      ...buildPluginDeclaredOnlySkills(plugins, knownSkillNames),
    );

    return {
      plugins,
      capabilities,
      generatedAt: Date.now(),
      sources: {
        plugins: 'electron/plugins/PluginManager',
        skills: 'packages/agent/src/skills',
        mcp: 'electron/agents/mcp/collect-main',
        ui: 'plugin-manifest',
        hooks: 'plugin-manifest',
        cli: 'plugin-manifest',
      },
      unsupported: PHASE_1B_UNSUPPORTED,
      crossSource: {
        skillCandidateCount: crossSkills.candidateCount,
        mcpCandidateCount: crossMcp.candidateCount,
        settingsOverrideApplied: crossSkills.settingsOverrideApplied,
      },
    };
  }
}

let _singleton: CapabilityManagementService | null = null;

export function getCapabilityManagementService(): CapabilityManagementService {
  if (!_singleton) {
    _singleton = new CapabilityManagementService();
  }
  return _singleton;
}

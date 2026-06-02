// packages/agent/tests/mcp/collector-engine-contract.test.ts
// Cross-package contract test: the worker collector feeds the
// resolution engine in @duya/plugin-core, and the engine must surface
// the bundled candidate (even when the script is missing) as an
// inventory row + a TYPED `mcp-bundled-missing` issue — NOT silently
// dropped, and NOT a generic `mcp-script-not-found`.
//
// Lives under packages/agent/tests/ because the test imports from
// both @duya/plugin-core and the worker collector. plugin-core's
// own tests cannot import the worker (wrong-direction dependency).

import { describe, it, expect } from 'vitest';
import { resolveMCPDiscovery } from '@duya/plugin-core';
import { buildWorkerMCPCandidates } from '../../src/mcp/collect-worker.js';

describe('collector → engine contract: bundled script missing produces a TYPED mcp-bundled-missing issue', () => {
  it('the engine emits exactly mcp-bundled-missing for a missing bundled script (no other type accepted)', async () => {
    // 1. Build a real worker output with the bundled literature path
    //    pointing at a non-existent script. The collector ALWAYS
    //    emits the bundled candidate (Phase 1B contract).
    const result = buildWorkerMCPCandidates({
      installedPlugins: [],
      agentSettingsMcpServers: [],
      settingsKvMcpServers: [],
      legacyFileMcpServers: undefined,
      environment: {},
      cwd: '/nonexistent/cwd/with/no/bundle',
    });
    const bundled = result.candidates.find((c) => c.source === 'bundled');
    expect(bundled).toBeDefined();
    expect(bundled!.rawConfig.args[0]).toContain('literature-mcp-server.js');
    expect(bundled!.rawConfig.command).toBe('node');

    // 2. Run the engine.
    const r = await resolveMCPDiscovery(result.candidates, {
      environment: {},
      userConfigByPlugin: {},
    });

    // 3. Inventory keeps the bundled entry with a non-configured
    //    discovery status.
    const inv = r.inventory.find(
      (e) => e.source === 'bundled' && e.serverName === 'literature',
    );
    expect(inv).toBeDefined();
    expect(inv!.discoveryStatus).not.toBe('configured');

    // 4. The engine emits EXACTLY mcp-bundled-missing (Phase 1B
    //    contract: bundled absence is a build/installation problem
    //    surfaced at the static-path-check stage, so phase is
    //    'resolution' — the same phase as mcp-script-not-found).
    //    NO other script-missing / command-missing shape is
    //    accepted for the bundled source.
    const bundleIssues = r.issues.filter((i) => {
      const err = i.error as { type: string; source?: { source?: string } };
      return err.type === 'mcp-bundled-missing' && err.source?.source === 'bundled';
    });
    expect(bundleIssues.length).toBeGreaterThan(0);
    expect(bundleIssues[0].phase).toBe('resolution');

    // 4a. None of the FORBIDDEN types appear for the bundled source.
    const forbidden = r.issues.filter((i) => {
      const err = i.error as { type: string; source?: { source?: string } };
      return (
        err.source?.source === 'bundled' &&
        (err.type === 'mcp-script-not-found' || err.type === 'mcp-command-missing')
      );
    });
    expect(forbidden).toEqual([]);

    // 4b. The mcp-bundled-missing issue carries a bundlePath.
    const e = bundleIssues[0].error as { bundlePath: string };
    expect(e.bundlePath).toContain('literature-mcp-server.js');
  });
});

describe('collector → engine contract: legacyFile 5-source round-trip', () => {
  it('worker collector with all 5 sources produces an inventory where legacyFile candidates are present, distinct, and resolvable', async () => {
    const items = { name: 'lit', command: 'node', args: [] };
    const result = buildWorkerMCPCandidates({
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 'plugin-mcp', command: 'node', args: [] }] } },
        },
      ],
      agentSettingsMcpServers: [items],
      settingsKvMcpServers: [items],
      legacyFileMcpServers: [items],
      environment: {},
      cwd: '/nonexistent/cwd',
    });
    const r = await resolveMCPDiscovery(result.candidates, {
      environment: {},
      userConfigByPlugin: {},
    });
    const invBundled = r.inventory.filter((e) => e.source === 'bundled');
    const invPlugin = r.inventory.filter((e) => e.source === 'plugin');
    const invSettings = r.inventory.filter((e) => e.source === 'settings');
    expect(invBundled.length).toBeGreaterThanOrEqual(1);
    expect(invPlugin.length).toBe(1);
    expect(invSettings.length).toBe(3);
    const legacyInv = invSettings.find((e) => e.sourceSubOrigin === 'legacyFile');
    expect(legacyInv).toBeDefined();
    expect(legacyInv!.shadowedBy).toBeDefined();
  });
});

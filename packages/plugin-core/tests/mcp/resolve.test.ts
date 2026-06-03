import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveMCPDiscovery } from '../../src/mcp/resolve.js';
import type { MCPCandidate, ResolutionContext } from '../../src/mcp/discovery.js';

const baseCtx: ResolutionContext = {
  environment: {},
  userConfigByPlugin: {},
};

const bundledLiterature = (bundled = true): MCPCandidate => ({
  source: 'bundled',
  rawConfig: {
    name: 'literature',
    // Skip path resolution (no pluginRoot) so the static check passes.
    command: 'node',
    args: [],
  },
});

const pluginLiterature = (enabled = true): MCPCandidate => ({
  source: 'plugin',
  sourceSubOrigin: undefined,
  pluginId: 'com.duya.literature',
  pluginName: 'Literature Plugin',
  pluginRoot: '/plugins/lit',
  pluginDataPath: '/data/lit',
  rawConfig: {
    name: 'literature',
    command: 'node',
    args: [],
  },
});

const settingsLiterature = (sub: 'legacyFile' | 'settingsKv' | 'agentSettings'): MCPCandidate => ({
  source: 'settings',
  sourceSubOrigin: sub,
  rawConfig: { name: 'literature', command: 'node', args: [] },
});

describe('resolveMCPDiscovery — shape and basic flow', () => {
  it('produces a single inventory entry for one well-formed candidate', async () => {
    const r = await resolveMCPDiscovery([bundledLiterature()], baseCtx);
    expect(r.inventory).toHaveLength(1);
    expect(r.inventory[0].discoveryStatus).toBe('configured');
    expect(r.resolvedConfigs).toHaveLength(1);
    expect(r.issues).toHaveLength(0);
  });

  it('emits a manifest_invalid issue for an invalid candidate but keeps it in inventory', async () => {
    const bad: MCPCandidate = {
      source: 'settings',
      sourceSubOrigin: 'agentSettings',
      rawConfig: { name: '', command: 'node', args: [] }, // empty name
    };
    const r = await resolveMCPDiscovery([bad], baseCtx);
    expect(r.inventory).toHaveLength(1);
    expect(r.inventory[0].discoveryStatus).toBe('manifest_invalid');
    expect(r.resolvedConfigs).toHaveLength(0);
    const issues = r.issues.filter((i) => i.phase === 'discovery');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].error.type).toBe('mcp-manifest-invalid');
  });

  it('emits an env-missing issue and sets env_missing status when env vars are missing', async () => {
    const c: MCPCandidate = {
      source: 'plugin',
      pluginId: 'p',
      pluginRoot: '/p',
      rawConfig: {
        name: 'p-server',
        command: 'node',
        args: ['./${MISSING}/index.js'],
        env: { TOKEN: '${MISSING_TOKEN}' },
      },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    expect(r.inventory[0].discoveryStatus).toBe('env_missing');
    const envIssues = r.issues.filter((i) => i.error.type === 'mcp-env-var-missing');
    expect(envIssues.length).toBe(1);
    expect((envIssues[0].error as { missingVars: string[] }).missingVars.sort()).toEqual([
      'MISSING',
      'MISSING_TOKEN',
    ]);
  });

  it('emits a user-config-missing issue when ${user_config.X} is unresolved', async () => {
    const c: MCPCandidate = {
      source: 'plugin',
      pluginId: 'p',
      pluginRoot: '/p',
      rawConfig: {
        name: 'p-server',
        command: 'node',
        args: [],
        env: { KEY: '${user_config.API_KEY}' },
      },
    };
    const r = await resolveMCPDiscovery([c], { environment: {}, userConfigByPlugin: {} });
    const userIssues = r.issues.filter((i) => i.error.type === 'mcp-user-config-missing');
    expect(userIssues.length).toBe(1);
    expect((userIssues[0].error as { missingKeys: string[] }).missingKeys).toEqual(['API_KEY']);
  });

  it('emits script_missing when a relative script path under pluginRoot does not exist', async () => {
    const c: MCPCandidate = {
      source: 'plugin',
      pluginId: 'p',
      pluginRoot: '/this/path/does/not/exist/abc',
      rawConfig: {
        name: 'p-server',
        command: 'node',
        args: ['./missing.js'],
      },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    expect(r.inventory[0].discoveryStatus).toBe('script_missing');
    const issues = r.issues.filter((i) => i.error.type === 'mcp-script-not-found');
    expect(issues.length).toBe(1);
  });

  it('emits command_missing for an empty command', async () => {
    const c: MCPCandidate = {
      source: 'settings',
      sourceSubOrigin: 'agentSettings',
      rawConfig: { name: 'empty-cmd', command: '   ', args: [] },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    expect(r.inventory[0].discoveryStatus).toBe('command_missing');
    const issues = r.issues.filter((i) => i.error.type === 'mcp-empty-command');
    expect(issues.length).toBe(1);
  });

  it('emits allowed_paths_violation when a relative path escapes the pluginRoot', async () => {
    const c: MCPCandidate = {
      source: 'plugin',
      pluginId: 'p',
      pluginRoot: process.cwd(),
      rawConfig: {
        name: 'escape',
        command: 'node',
        args: ['../../../etc/passwd'],
      },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    expect(r.inventory[0].discoveryStatus).toBe('allowed_paths_violation');
    const issues = r.issues.filter((i) => i.error.type === 'mcp-allowed-paths-violation');
    expect(issues.length).toBe(1);
  });

  it('emits an info issue for overrideTarget and ignores the field (Rev 5.1 deferred)', async () => {
    const c: MCPCandidate = {
      source: 'settings',
      sourceSubOrigin: 'agentSettings',
      rawConfig: { name: 's', command: 'node', args: [], overrideTarget: 'plugin:p:s' },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    const info = r.issues.filter((i) => i.error.type === 'mcp-override-target-not-supported');
    expect(info.length).toBe(1);
    expect(info[0].severity).toBe('info');
  });
});

describe('resolveMCPDiscovery — within-settings newest-wins', () => {
  it('agentSettings wins; legacyFile and settingsKv are shadowed', async () => {
    const r = await resolveMCPDiscovery(
      [settingsLiterature('legacyFile'), settingsLiterature('settingsKv'), settingsLiterature('agentSettings')],
      baseCtx,
    );
    expect(r.inventory).toHaveLength(3);
    const winner = r.inventory.find((e) => e.sourceSubOrigin === 'agentSettings');
    const losers = r.inventory.filter((e) => e.sourceSubOrigin !== 'agentSettings');
    expect(winner?.shadowedBy).toBeUndefined();
    for (const l of losers) {
      expect(l.shadowedBy).toBe(winner?.inventoryId);
    }
    expect(r.resolvedConfigs).toHaveLength(1);
    expect(r.resolvedConfigs[0].sourceSubOrigin).toBe('agentSettings');
    const shadowed = r.issues.filter((i) => i.error.type === 'mcp-server-shadowed');
    expect(shadowed.length).toBe(2);
  });

  it('with only one settings sub-origin, no shadowing happens', async () => {
    const r = await resolveMCPDiscovery([settingsLiterature('agentSettings')], baseCtx);
    expect(r.inventory[0].shadowedBy).toBeUndefined();
    expect(r.resolvedConfigs).toHaveLength(1);
    expect(r.issues.filter((i) => i.error.type === 'mcp-server-shadowed')).toHaveLength(0);
  });
});

describe('resolveMCPDiscovery — builtin fallback replacement (Rev 5.1)', () => {
  it('when plugin literature is enabled, bundled literature is shadowed and excluded from resolvedConfigs', async () => {
    const r = await resolveMCPDiscovery(
      [bundledLiterature(), pluginLiterature()],
      baseCtx,
    );
    expect(r.inventory).toHaveLength(2);
    const bundled = r.inventory.find((e) => e.source === 'bundled');
    const plugin = r.inventory.find((e) => e.source === 'plugin');
    expect(bundled?.shadowedBy).toBe(plugin?.inventoryId);
    expect(plugin?.shadowedBy).toBeUndefined();
    expect(r.resolvedConfigs).toHaveLength(1);
    expect(r.resolvedConfigs[0].source).toBe('plugin');
    const shadowed = r.issues.filter((i) => i.error.type === 'mcp-server-shadowed');
    expect(shadowed.length).toBe(1);
    expect((shadowed[0].error as { shadowedByInventoryId: string }).shadowedByInventoryId)
      .toBe(plugin?.inventoryId);
  });

  it('when the plugin is not present, bundled literature stands alone', async () => {
    const r = await resolveMCPDiscovery([bundledLiterature()], baseCtx);
    expect(r.inventory[0].shadowedBy).toBeUndefined();
    expect(r.resolvedConfigs).toHaveLength(1);
    expect(r.resolvedConfigs[0].source).toBe('bundled');
  });

  it('both bundled and plugin literature remain in inventory (visible to user)', async () => {
    const r = await resolveMCPDiscovery([bundledLiterature(), pluginLiterature()], baseCtx);
    expect(r.inventory).toHaveLength(2);
  });

  it('does NOT trigger for an arbitrary bundled entry that is not a known fallback', async () => {
    // Bundled "search" is NOT in BUILTIN_FALLBACK_REPLACEMENTS, so even
    // when a plugin "search" exists, both should be in resolvedConfigs.
    const r = await resolveMCPDiscovery(
      [
        { source: 'bundled', rawConfig: { name: 'search', command: 'node', args: [] } },
        { source: 'plugin', pluginId: 'pluginA', rawConfig: { name: 'search', command: 'node', args: [] } },
      ],
      baseCtx,
    );
    expect(r.resolvedConfigs).toHaveLength(2);
    expect(r.issues.filter((i) => i.error.type === 'mcp-server-shadowed')).toHaveLength(0);
  });

  it('does NOT trigger for an arbitrary plugin whose name happens to match a fallback bundled server name', async () => {
    // A plugin with id 'someone-else' exposing a server named 'literature'
    // is NOT the official literature plugin; bundled 'literature' should
    // NOT be shadowed by it.
    const imposter: MCPCandidate = {
      source: 'plugin',
      pluginId: 'someone-else',
      rawConfig: { name: 'literature', command: 'node', args: [] },
    };
    const r = await resolveMCPDiscovery([bundledLiterature(), imposter], baseCtx);
    expect(r.resolvedConfigs).toHaveLength(2);
    const bundled = r.inventory.find((e) => e.source === 'bundled');
    expect(bundled?.shadowedBy).toBeUndefined();
    expect(r.issues.filter((i) => i.error.type === 'mcp-server-shadowed')).toHaveLength(0);
  });

  it('does NOT trigger for the official plugin if its serverName differs from the bundled serverName', async () => {
    // The official literature plugin exporting a server called 'evidence'
    // (not 'literature') should NOT replace bundled 'literature'.
    const r = await resolveMCPDiscovery(
      [
        bundledLiterature(),
        {
          source: 'plugin',
          pluginId: 'com.duya.literature',
          rawConfig: { name: 'evidence', command: 'node', args: [] },
        },
      ],
      baseCtx,
    );
    expect(r.resolvedConfigs).toHaveLength(2);
    const bundled = r.inventory.find((e) => e.source === 'bundled');
    expect(bundled?.shadowedBy).toBeUndefined();
  });
});

describe('resolveMCPDiscovery — cross-source coexistence (Rev 5.1)', () => {
  it('two plugins with the same server name both connect; neither shadows the other', async () => {
    const a: MCPCandidate = {
      source: 'plugin', pluginId: 'pluginA',
      rawConfig: { name: 'search', command: 'node', args: [] },
    };
    const b: MCPCandidate = {
      source: 'plugin', pluginId: 'pluginB',
      rawConfig: { name: 'search', command: 'node', args: [] },
    };
    const r = await resolveMCPDiscovery([a, b], baseCtx);
    expect(r.inventory).toHaveLength(2);
    expect(r.inventory.every((e) => e.shadowedBy === undefined)).toBe(true);
    expect(r.resolvedConfigs).toHaveLength(2);
  });

  it('bundled and plugin with the same server name both connect (unless the plugin is a known fallback)', async () => {
    const r = await resolveMCPDiscovery(
      [
        { source: 'bundled', rawConfig: { name: 'generic', command: 'node', args: [] } },
        { source: 'plugin', pluginId: 'p', rawConfig: { name: 'generic', command: 'node', args: [] } },
      ],
      baseCtx,
    );
    expect(r.inventory).toHaveLength(2);
    expect(r.resolvedConfigs).toHaveLength(2);
  });
});

describe('resolveMCPDiscovery — phase tagging', () => {
  it('discovery phase issues come from manifest / shape failures', async () => {
    const c: MCPCandidate = {
      source: 'settings', sourceSubOrigin: 'agentSettings',
      rawConfig: { name: '', command: 'node', args: [] },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    const disc = r.issues.filter((i) => i.phase === 'discovery');
    expect(disc.length).toBeGreaterThan(0);
  });

  it('resolution phase issues come from env / path / shadow', async () => {
    const c: MCPCandidate = {
      source: 'plugin', pluginId: 'p', pluginRoot: '/p',
      rawConfig: { name: 'p', command: 'node', args: ['./${MISSING}/x.js'] },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    const res = r.issues.filter((i) => i.phase === 'resolution');
    expect(res.length).toBeGreaterThan(0);
  });

  it('does NOT produce connection or registration issues (those come from runtime)', async () => {
    const r = await resolveMCPDiscovery([bundledLiterature()], baseCtx);
    expect(r.issues.filter((i) => i.phase === 'connection' || i.phase === 'registration')).toHaveLength(0);
  });
});

describe('resolveMCPDiscovery — issue context has all required fields', () => {
  it('every issue carries phase, source, humanMessage, severity', async () => {
    const c: MCPCandidate = {
      source: 'settings', sourceSubOrigin: 'agentSettings',
      rawConfig: { name: 's', command: 'node', args: [] },
    };
    const r = await resolveMCPDiscovery([c], baseCtx);
    for (const i of r.issues) {
      expect(i.phase).toMatch(/^(discovery|resolution|connection|registration)$/);
      expect(i.source.source).toMatch(/^(bundled|plugin|settings)$/);
      expect(i.humanMessage.length).toBeGreaterThan(0);
      expect(['critical', 'warning', 'info']).toContain(i.severity);
    }
  });
});

// ============================================================================
// Phase 1C: builtin fallback replacement is gated on the official
// plugin entry's discoveryStatus. An invalid (env_missing /
// script_missing / manifest_invalid) official literature plugin
// must NOT shadow the bundled fallback — the bundled candidate
// remains connectable and is the user's only working fallback.
// ============================================================================

describe('resolveMCPDiscovery — builtin fallback replacement is gated on plugin discoveryStatus', () => {
  let tmpDir: string;
  let bundledScriptPath: string;

  beforeAll(() => {
    // Create a real bundled script so the bundled candidate is
    // truly connectable. We then deliberately break the official
    // plugin candidate (env_missing / script_missing / manifest_invalid)
    // and assert that the bundled fallback still reaches resolvedConfigs.
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-resolve-lit-'));
    bundledScriptPath = join(tmpDir, 'literature-mcp-server.js');
    writeFileSync(bundledScriptPath, '// real script stub');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configured official literature plugin DOES shadow a working bundled fallback', async () => {
    const result = await resolveMCPDiscovery(
      [
        {
          source: 'bundled',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: [bundledScriptPath, '--db-path', ''],
            env: { DUYA_BETTER_SQLITE3_PATH: '' },
          },
        },
        {
          source: 'plugin',
          pluginId: 'com.duya.literature',
          pluginName: 'Literature Plugin',
          pluginRoot: '/p',
          rawConfig: { name: 'literature', command: 'node', args: [] },
        },
      ],
      { environment: {}, userConfigByPlugin: {} },
    );
    const bundled = result.inventory.find(
      (e) => e.source === 'bundled' && e.serverName === 'literature',
    );
    const plugin = result.inventory.find(
      (e) => e.source === 'plugin' && e.serverName === 'literature',
    );
    expect(bundled).toBeDefined();
    expect(bundled!.discoveryStatus).toBe('configured');
    expect(plugin).toBeDefined();
    expect(plugin!.discoveryStatus).toBe('configured');
    expect(bundled!.shadowedBy).toBe(plugin!.inventoryId);
    // Only the plugin entry reaches resolvedConfigs; the bundled
    // fallback is shadowed out.
    expect(result.resolvedConfigs.map((c) => c.source).sort()).toEqual(['plugin']);
  });

  it('env_missing official literature plugin does NOT shadow a working bundled fallback', async () => {
    const result = await resolveMCPDiscovery(
      [
        {
          source: 'bundled',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: [bundledScriptPath, '--db-path', ''],
            env: { DUYA_BETTER_SQLITE3_PATH: '' },
          },
        },
        {
          source: 'plugin',
          pluginId: 'com.duya.literature',
          pluginName: 'Literature Plugin',
          pluginRoot: '/p',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: ['./${MISSING}/x.js'],   // unresolved → env_missing
          },
        },
      ],
      { environment: {}, userConfigByPlugin: {} },
    );
    const bundled = result.inventory.find(
      (e) => e.source === 'bundled' && e.serverName === 'literature',
    );
    const plugin = result.inventory.find(
      (e) => e.source === 'plugin' && e.serverName === 'literature',
    );
    expect(bundled).toBeDefined();
    expect(bundled!.discoveryStatus).toBe('configured');
    expect(plugin).toBeDefined();
    expect(plugin!.discoveryStatus).toBe('env_missing');
    // Plugin does NOT shadow bundled because it failed resolution.
    expect(bundled!.shadowedBy).toBeUndefined();
    // The bundled fallback stays in resolvedConfigs as the only
    // working option. The plugin entry is also surfaced in
    // inventory (so the user can see the env_missing diagnostic)
    // but is NOT in resolvedConfigs — `resolvedConfigs` is the
    // connectable subset only, by definition.
    expect(result.resolvedConfigs.map((c) => c.source).sort()).toEqual(['bundled']);
    expect(result.inventory.some((e) => e.source === 'plugin' && e.serverName === 'literature')).toBe(true);
    // Issues surface the env_missing on plugin and the shadow
    // policy NOT having been applied.
    const envMissing = result.issues.find((i) => i.error.type === 'mcp-env-var-missing');
    expect(envMissing).toBeDefined();
  });

  it('script_missing official literature plugin does NOT shadow a working bundled fallback', async () => {
    // We point the plugin's first arg at a path that does not exist
    // (relative to the worker's cwd). The plugin candidate is fully
    // formed; staticPathCheck will fail with script_missing. The
    // bundled candidate uses the real tmp script and stays connected.
    const result = await resolveMCPDiscovery(
      [
        {
          source: 'bundled',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: [bundledScriptPath, '--db-path', ''],
            env: { DUYA_BETTER_SQLITE3_PATH: '' },
          },
        },
        {
          source: 'plugin',
          pluginId: 'com.duya.literature',
          pluginName: 'Literature Plugin',
          pluginRoot: '/p',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: ['./definitely-missing-plugin-script.js'],
          },
        },
      ],
      { environment: {}, userConfigByPlugin: {} },
    );
    const bundled = result.inventory.find(
      (e) => e.source === 'bundled' && e.serverName === 'literature',
    );
    const plugin = result.inventory.find(
      (e) => e.source === 'plugin' && e.serverName === 'literature',
    );
    expect(bundled!.discoveryStatus).toBe('configured');
    expect(plugin!.discoveryStatus).toBe('script_missing');
    expect(bundled!.shadowedBy).toBeUndefined();
    // Bundled fallback stays in resolvedConfigs as the only
    // working option. The broken plugin is in inventory (for
    // diagnostic purposes) but not in resolvedConfigs.
    expect(result.resolvedConfigs.map((c) => c.source).sort()).toEqual(['bundled']);
    expect(result.inventory.some((e) => e.source === 'plugin' && e.serverName === 'literature')).toBe(true);
  });

  it('manifest_invalid official literature plugin is filtered upstream and bundled fallback is unaffected', async () => {
    // The collector decides what becomes a plugin candidate. When
    // the manifest cannot be parsed, the collector emits no plugin
    // candidate at all (it is not the resolution engine's job to
    // synthesize one). We simulate that by passing ONLY the bundled
    // candidate and asserting the engine's shadow policy is a no-op.
    //
    // This test belongs at the collector/loader layer, NOT the
    // resolution engine layer, because the engine never sees the
    // invalid plugin entry. We assert here ONLY that the engine's
    // shadow logic does NOT mis-fire when the plugin side is empty.
    const result = await resolveMCPDiscovery(
      [
        {
          source: 'bundled',
          rawConfig: {
            name: 'literature',
            command: 'node',
            args: [bundledScriptPath, '--db-path', ''],
            env: { DUYA_BETTER_SQLITE3_PATH: '' },
          },
        },
      ],
      { environment: {}, userConfigByPlugin: {} },
    );
    const bundled = result.inventory.find(
      (e) => e.source === 'bundled' && e.serverName === 'literature',
    );
    expect(bundled!.shadowedBy).toBeUndefined();
    expect(bundled!.discoveryStatus).toBe('configured');
    expect(result.resolvedConfigs.map((c) => c.source)).toEqual(['bundled']);
  });
});

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '../types.js';

export interface PluginRegistryEntry {
  id?: unknown;
  enabled?: unknown;
  installPath?: unknown;
  manifest?: unknown;
}

export interface PluginManifestData {
  capabilities?: {
    mcpServers?: PluginMCPServerManifest[];
  };
}

export interface PluginMCPServerManifest {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RuntimePathOptions {
  cwd?: string;
  resourcesPath?: string;
  defaultApp?: boolean;
  execPath?: string;
  exists?: (candidate: string) => boolean;
}

interface BuildPluginMCPServerConfigsOptions extends RuntimePathOptions {
  installedPlugins: PluginRegistryEntry[];
  readManifest?: (installPath: string) => Promise<PluginManifestData | null>;
  onWarn?: (message: string) => void;
}

// ============================================================================
// Bundled MCP Server Config Resolution
// ============================================================================
//
// Phase 1C fix: this function used to live in agent-process-entry.ts
// and was deleted when the init path switched to
// `loadAndResolveMCPServers()`. The reload path, which still uses
// the legacy `discover*` functions, silently lost the bundled
// fallback as a result. We restore it here with byte-equivalent
// behavior: the same `process.resourcesPath` / `cwd` heuristic, the
// same literature bundle name, the same env wiring.
//
// The init path does NOT use this function — it goes through
// `loadAndResolveMCPServers()` → `collectWorkerMCPCandidates` (see
// packages/agent/src/mcp/collect-worker.ts), which inlines an
// equivalent resolver. The two paths are kept in sync manually;
// this is the documented equivalence (Phase 1C audit §A.1).
export function resolveBundledMCPServerConfigs(): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];

  const isPackaged = !!process.resourcesPath && !process.defaultApp;

  const literatureBundlePath = isPackaged
    ? path.join(process.resourcesPath, 'agent-bundle', 'literature-mcp-server.js')
    : path.join(process.cwd(), 'packages', 'agent', 'bundle', 'literature-mcp-server.js');

  if (existsSync(literatureBundlePath)) {
    configs.push({
      name: 'literature',
      // Use the current runtime executable to avoid hard dependency on system `node`
      // in packaged desktop environments.
      command: process.execPath,
      args: [literatureBundlePath, '--db-path', process.env.DUYA_CUSTOM_DB_PATH || ''],
      env: {
        DUYA_BETTER_SQLITE3_PATH: process.env.DUYA_BETTER_SQLITE3_PATH || '',
      },
    });
  } else {
    console.warn('[Agent-Process] Literature MCP server bundle not found:', literatureBundlePath);
  }

  return configs;
}

function resolveBundledAgentBundleScript(scriptPath: string, options: RuntimePathOptions): string | null {
  const scriptName = path.basename(scriptPath);
  const isPackaged = !!options.resourcesPath && !options.defaultApp;
  const cwd = options.cwd || process.cwd();
  const hasPath = options.exists || existsSync;
  const candidates = isPackaged
    ? [path.join(options.resourcesPath!, 'agent-bundle', scriptName)]
    : [
        path.join(cwd, 'packages', 'agent', 'bundle', scriptName),
        path.join(cwd, 'agent-bundle', scriptName),
      ];

  for (const candidate of candidates) {
    if (hasPath(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolvePluginMCPPath(
  installPath: string,
  rawPath: string,
  options: RuntimePathOptions = {},
): string {
  if (!rawPath.startsWith('./') && !rawPath.startsWith('../')) {
    return rawPath;
  }

  const hasPath = options.exists || existsSync;
  const installRelativePath = path.resolve(installPath, rawPath);
  if (hasPath(installRelativePath)) {
    return installRelativePath;
  }

  if (rawPath.includes('agent-bundle')) {
    const bundledPath = resolveBundledAgentBundleScript(rawPath, options);
    if (bundledPath) {
      return bundledPath;
    }
  }

  return installRelativePath;
}

export function normalizePluginMCPServerConfig(
  pluginId: string,
  installPath: string,
  server: PluginMCPServerManifest,
  options: RuntimePathOptions = {},
  onWarn?: (message: string) => void,
): MCPServerConfig | null {
  const rawCommand = server.command?.trim();
  if (!rawCommand) {
    onWarn?.(`[Agent-Process] Skipping MCP server with empty command from plugin ${pluginId}`);
    return null;
  }

  const execPath = options.execPath || process.execPath;
  const hasPath = options.exists || existsSync;
  const command = rawCommand === 'node'
    ? execPath
    : resolvePluginMCPPath(installPath, rawCommand, options);

  const args = (server.args || []).map((arg: string) => resolvePluginMCPPath(installPath, arg, options));

  const scriptArg = args[0];
  const runsNodeScript = command === execPath || command.endsWith('node') || command.endsWith('node.exe');
  if (runsNodeScript && scriptArg && !hasPath(scriptArg)) {
    onWarn?.(
      `[Agent-Process] Skipping MCP server "${server.name}" from plugin ${pluginId}: script not found at ${scriptArg}`,
    );
    return null;
  }

  if (command !== execPath && (command.startsWith('./') || command.startsWith('../')) && !hasPath(command)) {
    onWarn?.(
      `[Agent-Process] Skipping MCP server "${server.name}" from plugin ${pluginId}: command not found at ${command}`,
    );
    return null;
  }

  return {
    name: server.name,
    command,
    args,
    env: server.env,
  };
}

async function defaultReadManifest(installPath: string): Promise<PluginManifestData | null> {
  const manifestPath = existsSync(path.join(installPath, 'plugin.json'))
    ? path.join(installPath, 'plugin.json')
    : path.join(installPath, 'duya-plugin.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as PluginManifestData;
  } catch {
    return null;
  }
}

export async function buildPluginMCPServerConfigs(
  options: BuildPluginMCPServerConfigsOptions,
): Promise<MCPServerConfig[]> {
  const configs: MCPServerConfig[] = [];
  const readManifest = options.readManifest || defaultReadManifest;
  const enabledPlugins = options.installedPlugins.filter(
    (item) => item.enabled === true && typeof item.id === 'string' && typeof item.installPath === 'string',
  );

  for (const plugin of enabledPlugins) {
    const installPath = plugin.installPath as string;
    let manifest: PluginManifestData | null = null;

    if (plugin.manifest && typeof plugin.manifest === 'object') {
      manifest = plugin.manifest as PluginManifestData;
    } else {
      manifest = await readManifest(installPath);
    }

    if (!manifest?.capabilities?.mcpServers) {
      continue;
    }

    for (const server of manifest.capabilities.mcpServers) {
      const normalized = normalizePluginMCPServerConfig(
        plugin.id as string,
        installPath,
        server,
        options,
        options.onWarn,
      );
      if (normalized) {
        configs.push(normalized);
      }
    }
  }

  return configs;
}

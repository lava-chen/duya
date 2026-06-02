import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PluginCatalogEntry, PluginCategory } from './types';
import { readPluginManifest } from './manifest';
import { getLogger, LogComponent } from '../logging/logger';

const COMPONENT = 'PluginCatalog' as LogComponent;

interface LocalMarketplacePlugin {
  name: string;
  source: {
    source: string;
    path: string;
  };
  policy?: {
    installation?: string;
    authentication?: string;
  };
  category?: string;
}

interface LocalMarketplaceFile {
  name: string;
  plugins: LocalMarketplacePlugin[];
}

function readLocalMarketplaceFile(): LocalMarketplaceFile | null {
  try {
    const userData = app.getPath('userData');
    const marketplacePath = path.join(userData, 'plugins', 'marketplace.json');
    if (!fs.existsSync(marketplacePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.plugins)) {
      return null;
    }
    return raw as LocalMarketplaceFile;
  } catch {
    return null;
  }
}

const VALID_CATEGORIES: Set<string> = new Set([
  'productivity', 'development', 'research', 'data',
  'communication', 'media', 'automation', 'other',
]);

function normalizeCategory(cat: string | undefined): PluginCategory {
  if (!cat) return 'other';
  const lower = cat.toLowerCase();
  if (VALID_CATEGORIES.has(lower)) return lower as PluginCategory;
  return 'other';
}

function countCapabilities(manifest: Record<string, unknown>): {
  skills: number;
  mcpServers: number;
  cli: number;
  ui: number;
  hooks: number;
} {
  const caps = (manifest.capabilities || {}) as Record<string, unknown>;
  return {
    skills: Array.isArray(caps.skills) ? caps.skills.length : 0,
    mcpServers: Array.isArray(caps.mcpServers) ? caps.mcpServers.length : 0,
    cli: Array.isArray(caps.cli) ? caps.cli.length : 0,
    ui: Array.isArray(caps.ui) ? caps.ui.length : 0,
    hooks: Array.isArray(caps.hooks) ? caps.hooks.length : 0,
  };
}

function buildLocalCatalogEntry(
  mpEntry: LocalMarketplacePlugin,
  manifest: Record<string, unknown>,
): PluginCatalogEntry {
  const id = (manifest.id as string) || `com.duya.${mpEntry.name}`;
  const name = (manifest.name as string) || mpEntry.name;
  const version = (manifest.version as string) || '0.1.0';
  const description = (manifest.description as string) || `Plugin: ${mpEntry.name}`;
  const author = (manifest.author as { name: string; url?: string }) || { name: 'Unknown' };

  return {
    id,
    name,
    version,
    description,
    source: 'local',
    category: normalizeCategory(mpEntry.category),
    trustLevel: 'local',
    capabilityCounts: countCapabilities(manifest),
    manifest: manifest as PluginCatalogEntry['manifest'],
    author,
  };
}

function getLocalCatalogEntries(): PluginCatalogEntry[] {
  const logger = getLogger();
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return [];
  }

  const entries: PluginCatalogEntry[] = [];
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

  for (const mpEntry of marketplace.plugins) {
    try {
      let pluginDir = mpEntry.source.path;
      if (!path.isAbsolute(pluginDir)) {
        pluginDir = path.resolve(marketplaceDir, pluginDir);
      }

      if (!fs.existsSync(pluginDir)) {
        logger.warn('Local plugin directory not found', { name: mpEntry.name, path: pluginDir }, COMPONENT);
        continue;
      }

      const manifest = readPluginManifest(pluginDir);
      const entry = buildLocalCatalogEntry(mpEntry, manifest as unknown as Record<string, unknown>);
      entries.push(entry);
    } catch (err) {
      logger.warn('Failed to read local plugin manifest', {
        name: mpEntry.name,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
    }
  }

  return entries;
}

export const BUNDLED_PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    id: 'com.duya.literature',
    name: 'Literature Plugin',
    version: '0.1.0',
    description: 'Literature asset and evidence management for research workflows.',
    source: 'bundled',
    category: 'research',
    trustLevel: 'official',
    capabilityCounts: {
      skills: 2,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
    },
    manifest: {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.literature',
      name: 'Literature Plugin',
      version: '0.1.0',
      description: 'Literature asset and evidence management for research workflows.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: ['paper-analysis', 'citation-format'],
        mcpServers: [
          {
            name: 'literature',
            command: 'node',
            args: ['./agent-bundle/literature-mcp-server.js'],
          },
        ],
      },
      permissions: [
        { name: 'agent.memory.read', scope: 'research' },
        { name: 'agent.memory.write', scope: 'research' },
        { name: 'workspace.read' },
      ],
      engines: { duya: '>=0.1.0', node: '>=20' },
    },
  },
  {
    id: 'com.duya.devtools',
    name: 'DevTools Plus',
    version: '0.1.0',
    description: 'Developer helpers with MCP server and CLI tools.',
    source: 'bundled',
    category: 'development',
    trustLevel: 'official',
    capabilityCounts: {
      skills: 0,
      mcpServers: 1,
      cli: 1,
      ui: 0,
      hooks: 0,
    },
    manifest: {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.devtools',
      name: 'DevTools Plus',
      version: '0.1.0',
      description: 'Developer helpers with MCP server and CLI tools.',
      author: { name: 'DUYA Team' },
      capabilities: {
        mcpServers: [
          {
            name: 'devtools',
            command: 'node',
            args: ['./dist/mcp-server.js'],
          },
        ],
        cli: [
          {
            name: 'devtools',
            command: './bin/devtools',
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      engines: { duya: '>=0.1.0' },
    },
  },
];

let cachedCatalog: PluginCatalogEntry[] | null = null;
let cachedCatalogAt = 0;
const CACHE_TTL_MS = 5000;

export function getPluginCatalog(): PluginCatalogEntry[] {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogAt) < CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const localEntries = getLocalCatalogEntries();
  cachedCatalog = [...BUNDLED_PLUGIN_CATALOG, ...localEntries];
  cachedCatalogAt = now;
  return cachedCatalog;
}

export function getPluginCatalogEntry(id: string): PluginCatalogEntry | undefined {
  const catalog = getPluginCatalog();
  return catalog.find((entry) => entry.id === id);
}

export function getLocalPluginPaths(): Map<string, string> {
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return new Map();
  }

  const result = new Map<string, string>();
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

  for (const entry of marketplace.plugins) {
    let pluginDir = entry.source.path;
    if (!path.isAbsolute(pluginDir)) {
      pluginDir = path.resolve(marketplaceDir, pluginDir);
    }
    if (fs.existsSync(pluginDir)) {
      result.set(entry.name, pluginDir);
    }
  }

  return result;
}

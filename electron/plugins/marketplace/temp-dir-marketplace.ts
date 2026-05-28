import fs from 'fs';
import path from 'path';
import type { MarketplaceCatalog, MarketplacePluginEntry } from './types';

export function scanDirectoryForPlugins(dirPath: string): MarketplaceCatalog {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const plugins: Record<string, MarketplacePluginEntry> = {};

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(dirPath, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);

      const pluginName = manifest.name || entry.name;
      const pluginVersion = manifest.version || '0.0.0';
      const pluginDesc = manifest.description || `Local plugin from directory: ${pluginDir}`;

      plugins[pluginName] = {
        name: pluginName,
        description: pluginDesc,
        version: pluginVersion,
        source: { type: 'local', url: pluginDir },
        author: manifest.author || { name: 'Unknown' },
        categories: manifest.categories || ['local'],
        tags: manifest.tags || [],
        minDuyaVersion: manifest.engines?.duya,
        homepage: manifest.homepage,
      };
    } catch {
      continue;
    }
  }

  return {
    name: `temp-dir:${path.basename(dirPath)}`,
    version: 1,
    plugins,
  };
}
/**
 * official-seeds.ts — the marketplaces every installation starts with.
 *
 * The list used to live in the Desktop's marketplace manager, which meant the
 * only code that could tell a pre-seeded source from a user-added one ran
 * inside Electron. Both facts matter at once: the seeding pass writes these
 * into `[marketplaces]`, and a surface that removes one has to leave a
 * `removed` tombstone instead of deleting the key, or the next launch re-adds
 * what the user just took away. With one list, a TUI removal and a Desktop
 * removal write the same config.
 *
 * `registryName` is the key written under `[marketplaces]`. It is stable —
 * changing it would orphan an existing user's clone — so it is declared
 * explicitly instead of being derived from the display name.
 */

import type { MarketplaceSourceConfig } from './git-source.js';

export interface OfficialMarketplaceSeed {
  registryName: string;
  source: MarketplaceSourceConfig;
}

export const DEFAULT_OFFICIAL_SOURCES: ReadonlyArray<OfficialMarketplaceSeed> = [
  {
    registryName: 'official',
    source: {
      source: 'git',
      displayName: 'DUYA Official',
      // Gitee primary (好连接 both domestically and abroad) with the GitHub
      // repository as the mirror.
      urls: [
        'https://gitee.com/lava-chen/duya-marketplace.git',
        'https://github.com/lava-chen/duya-marketplace.git',
      ],
    },
  },
  {
    registryName: 'claude-plugins-official',
    source: {
      source: 'git',
      displayName: 'Claude Code Official',
      // anthropics/claude-plugins-official. Catalog: .claude-plugin/marketplace.json.
      urls: ['https://github.com/anthropics/claude-plugins-official.git'],
    },
  },
  {
    registryName: 'codex-official',
    source: {
      source: 'git',
      displayName: 'Codex Official',
      // openai/plugins. Catalog: .agents/plugins/marketplace.json, whose
      // UPPERCASE policy enums the format registry folds to canonical lowercase.
      urls: ['https://github.com/openai/plugins.git'],
    },
  },
  {
    registryName: 'cursor-official',
    source: {
      source: 'git',
      displayName: 'Cursor Official',
      // cursor/plugins. Catalog: .cursor-plugin/marketplace.json.
      urls: ['https://github.com/cursor/plugins.git'],
    },
  },
];

/** Legacy key for the first (duya) source. */
export const DEFAULT_OFFICIAL_MARKETPLACE = 'official';

/** Back-compat shim: code that imports the singular form. */
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig = DEFAULT_OFFICIAL_SOURCES[0].source;

/** True when `name` is a source a launch would re-seed. */
export function isDefaultOfficialSource(name: string): boolean {
  return DEFAULT_OFFICIAL_SOURCES.some((seed) => seed.registryName === name);
}

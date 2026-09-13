// cursor.ts — adapter for the Cursor plugin layout.
//
// Cursor's plugin manifest is structurally identical to Claude Code's
// minimal shape (`.cursor-plugin/plugin.json` with name / description /
// author), and duya already probed `.cursor-plugin/marketplace.json` for
// catalogs. Rather than duplicate the normalizer, reuse Claude's — the two
// formats only differ by folder name.

import type { FormatAdapter } from './types';
import { claudeCodeAdapter } from './claude-code';

export const cursorAdapter: FormatAdapter = {
  id: 'cursor',
  label: 'Cursor',
  priority: 30,
  pluginManifestPaths: ['.cursor-plugin/plugin.json'],
  catalogPaths: ['.cursor-plugin/marketplace.json'],
  // Same structural shape as Claude Code.
  detectCatalogSource: claudeCodeAdapter.detectCatalogSource,
  normalizeCatalogSource: claudeCodeAdapter.normalizeCatalogSource,
  normalizePluginManifest: claudeCodeAdapter.normalizePluginManifest,
};

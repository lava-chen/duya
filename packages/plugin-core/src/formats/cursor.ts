// cursor.ts — adapter for Cursor's plugin format
// (cursor/plugins — "Cursor plugin specification and official plugins",
// 7.5k stars, verified 2026-09-13; 78 catalog entries).
//
// Cursor's CATALOG is Claude-shaped — sources are bare repo-relative
// strings (no `./` prefix), which is why the Claude source normalizer is
// reused here rather than duplicated:
//
//   .cursor-plugin/marketplace.json
//   { "name": "cursor-plugins",
//     "owner": { "name": "Cursor", "email": "plugins@cursor.com" },
//     "metadata": { "description": "…" },
//     "plugins": [ { "name": "teaching", "source": "teaching",
//                    "description": "…" }, … ] }
//
// Cursor's PLUGIN MANIFEST is NOT Claude-shaped: every presentation field
// sits at the top level instead of inside an `interface` block, and there
// is no `interface` block at all:
//
//   .cursor-plugin/plugin.json
//   { "name": "advisor", "displayName": "Advisor", "version": "1.0.0",
//     "description": "…", "author": { "name": "Cursor", … },
//     "homepage": "…", "repository": "…", "license": "MIT",
//     "logo": "assets/avatar.png", "category": "developer-tools",
//     "keywords": [...], "tags": [...],
//     "skills": "./skills/", "agents": "./agents/", "rules": "./rules/" }
//
// So it needs its own normalizer: top-level `displayName` / `logo` /
// `category` fold into the canonical interface block, and the path-string
// capability pointers (`skills` / `agents` / `rules`) land in `declared`.
//
// Known drop: Cursor's top-level `tags` array has no home in duya's plugin
// interface today. It is intentionally not faked into `keywords`; if the
// UI grows a tag row, add `tags` to NormalizedInterface + duya's
// parseInterfaceBlock together.

import type {
  FormatAdapter,
  NormalizedDeclaredCapabilities,
  NormalizedPluginManifest,
} from './types';
import { claudeCodeAdapter } from './claude-code';
import {
  asString,
  asStringArray,
  buildInterfaceBlock,
  isPlainObject,
  normalizeAuthor,
  normalizeVersion,
  requireName,
} from './shared';

const PLUGIN_MANIFEST_PATHS = ['.cursor-plugin/plugin.json'] as const;
const CATALOG_PATHS = ['.cursor-plugin/marketplace.json'] as const;

function normalizeCursorPluginManifest(raw: unknown): NormalizedPluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error('cursor plugin manifest must be a JSON object');
  }
  const name = requireName(raw, 'cursor');

  // Hoist Cursor's top-level presentation fields into the shape the shared
  // interface builder understands. A nested `interface` block, if some
  // future manifest adds one, still wins on a per-field basis.
  const nested: Record<string, unknown> = isPlainObject(raw.interface) ? raw.interface : {};
  const interfaceBlock = buildInterfaceBlock(
    {
      ...nested,
      displayName: nested.displayName ?? raw.displayName,
      category: nested.category ?? raw.category,
    },
    [raw.logo, raw.composerIcon],
  );

  const declared: NormalizedDeclaredCapabilities = {};
  const skills = asString(raw.skills);
  if (skills) declared.skills = skills;
  const agents = asString(raw.agents);
  if (agents) declared.agents = agents;
  const rules = asString(raw.rules);
  if (rules) declared.rules = rules;
  const mcpServers = asString(raw.mcpServers);
  if (mcpServers) declared.mcpServers = mcpServers;

  return {
    name,
    version: normalizeVersion(raw.version),
    description: asString(raw.description),
    author: normalizeAuthor(raw.author),
    license: asString(raw.license),
    keywords: asStringArray(raw.keywords),
    homepage: asString(raw.homepage),
    repository: asString(raw.repository),
    ...(interfaceBlock ? { interface: interfaceBlock } : {}),
    ...(Object.keys(declared).length > 0 ? { declared } : {}),
  };
}

export const cursorAdapter: FormatAdapter = {
  id: 'cursor',
  label: 'Cursor',
  priority: 30,
  pluginManifestPaths: PLUGIN_MANIFEST_PATHS,
  catalogPaths: CATALOG_PATHS,
  // Catalog sources are the same bare-string / git-object family as Claude's,
  // so the source handling is shared rather than duplicated.
  detectCatalogSource: claudeCodeAdapter.detectCatalogSource,
  normalizeCatalogSource: claudeCodeAdapter.normalizeCatalogSource,
  normalizePluginManifest: normalizeCursorPluginManifest,
};

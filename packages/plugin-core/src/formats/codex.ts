// codex.ts — adapter for OpenAI Codex / ChatGPT plugin format
// (openai/plugins, verified 2026-09-13).
//
// Two things differ from duya's canonical model:
//
// 1. Catalog location. Codex keeps its catalog at
//      .agents/plugins/marketplace.json
//      .agents/plugins/api_marketplace.json
//    and its catalog *source* already uses the canonical
//    `{ source: 'local' | 'git', … }` shape, so no source normalizer is
//    needed here (the duya adapter owns it).
//
//    Codex DOES differ in policy enum case — it emits UPPERCASE
//    ("AVAILABLE" / "ON_INSTALL"). That folding is format-independent and
//    lives on the registry (`normalizeCatalogPolicy`).
//
// 2. Plugin manifest. `.codex-plugin/plugin.json` is a superset of duya's:
//    identity fields match, but the presentation block carries
//    `composerIcon` / `logo` (not `icon`) and the capability pointers are
//    path strings:
//
//      {
//        "name": "figma", "version": "2.0.20",
//        "author": { "name": "Figma", "url": "https://www.figma.com" },
//        "skills": "./skills/", "apps": "./.app.json",
//        "mcpServers": "./.mcp.json",
//        "interface": { "displayName": "Figma", "category": "Creativity",
//                       "brandColor": "#1ABCFE",
//                       "composerIcon": "./assets/logo-padded.png", … }
//      }
//
//    duya discovers the real capability set from disk; the path strings are
//    surfaced as `declared` hints.

import type {
  FormatAdapter,
  NormalizedDeclaredCapabilities,
  NormalizedPluginManifest,
} from './types';
import {
  asString,
  asStringArray,
  buildInterfaceBlock,
  isPlainObject,
  normalizeAuthor,
  normalizeVersion,
  requireName,
} from './shared';

const PLUGIN_MANIFEST_PATHS = ['.codex-plugin/plugin.json'] as const;
const CATALOG_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
] as const;

function normalizeCodexPluginManifest(raw: unknown): NormalizedPluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error('codex plugin manifest must be a JSON object');
  }
  const name = requireName(raw, 'codex');

  // Codex puts the icon under `composerIcon` / `logo`; shared
  // buildInterfaceBlock already falls back across icon → composerIcon → logo.
  const interfaceBlock = buildInterfaceBlock(raw.interface);

  const declared: NormalizedDeclaredCapabilities = {};
  const skills = asString(raw.skills);
  if (skills) declared.skills = skills;
  const mcpServers = asString(raw.mcpServers);
  if (mcpServers) declared.mcpServers = mcpServers;
  const apps = asString(raw.apps);
  if (apps) declared.apps = apps;
  const hooks = asString(raw.hooks);
  if (hooks) declared.hooks = hooks;

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

export const codexAdapter: FormatAdapter = {
  id: 'codex',
  label: 'OpenAI Codex',
  priority: 20,
  pluginManifestPaths: PLUGIN_MANIFEST_PATHS,
  catalogPaths: CATALOG_PATHS,
  // No detectCatalogSource / normalizeCatalogSource: Codex's catalog source
  // already uses duya's canonical local/git union, and its policy-case quirk
  // is handled format-independently by the registry.
  normalizePluginManifest: normalizeCodexPluginManifest,
};

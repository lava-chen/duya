// claude-code.ts — adapter for Anthropic's Claude Code plugin format
// (anthropics/claude-plugins-official, 295 plugins verified 2026-09-13).
//
// Two shapes differ from duya's canonical model:
//
// 1. Catalog source. Claude's `marketplace.json` uses a plain string for a
//    repo-relative path, plus `git-subdir` / `url` objects for external
//    repos, and names its pin `ref` (duya says `ref_name`):
//
//      { "name": "agent-sdk-dev", "source": "./plugins/agent-sdk-dev" }
//      { "name": "api-security-testing",
//        "source": { "source": "git-subdir",
//                    "url": "https://github.com/42Crunch-AI/claude-plugins.git",
//                    "path": "plugins/api-security-testing",
//                    "ref": "v1.5.5", "sha": "30287f…" } }
//      { "name": "agentforce-adlc",
//        "source": { "source": "url",
//                    "url": "https://github.com/…/agentforce-adlc.git",
//                    "sha": "b280f6…" } }
//
// 2. Plugin manifest. Claude ships a minimal `.claude-plugin/plugin.json`
//    with `name` / `description` / `author` and usually NO `version`:
//
//      { "name": "agent-sdk-dev",
//        "description": "Claude Agent SDK Development Plugin",
//        "author": { "name": "Anthropic", "email": "support@anthropic.com" } }

import type {
  FormatAdapter,
  NormalizedPluginManifest,
  NormalizedPluginSource,
} from './types';
import {
  GIT_URL_LIKE,
  asString,
  asStringArray,
  buildInterfaceBlock,
  isPlainObject,
  normalizeAuthor,
  normalizeVersion,
  requireName,
} from './shared';

const PLUGIN_MANIFEST_PATHS = ['.claude-plugin/plugin.json'] as const;
const CATALOG_PATHS = ['.claude-plugin/marketplace.json'] as const;

/** Git-shaped Claude catalog sources (all collapse to duya's `git`). */
const CLAUDE_GIT_DISCRIMINATORS = new Set(['git-subdir', 'url', 'github', 'git']);

export function normalizeClaudeCatalogSource(raw: unknown): NormalizedPluginSource {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) throw new Error('claude-code catalog source is empty');
    // A bare string is a repo-relative path unless it looks like a URL.
    return GIT_URL_LIKE.test(s) ? { source: 'git', url: s } : { source: 'local', path: s };
  }
  if (isPlainObject(raw)) {
    const disc = raw.source;
    if (typeof disc === 'string' && CLAUDE_GIT_DISCRIMINATORS.has(disc)) {
      const url = asString(raw.url);
      if (!url) throw new Error('claude-code git source is missing "url"');
      const sub = asString(raw.path);
      const ref = asString(raw.ref_name) ?? asString(raw.ref);
      const sha = asString(raw.sha);
      return {
        source: 'git',
        url,
        ...(sub ? { path: sub } : {}),
        ...(ref ? { ref_name: ref } : {}),
        ...(sha ? { sha } : {}),
      };
    }
    if (disc === 'local') {
      const path = asString(raw.path);
      if (!path) throw new Error('claude-code local source is missing "path"');
      return { source: 'local', path };
    }
  }
  throw new Error('unrecognized claude-code catalog source');
}

function normalizeClaudePluginManifest(raw: unknown): NormalizedPluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error('claude-code plugin manifest must be a JSON object');
  }
  const name = requireName(raw, 'claude-code');
  const interfaceBlock = buildInterfaceBlock(raw.interface);
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
  };
}

export const claudeCodeAdapter: FormatAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  priority: 10,
  pluginManifestPaths: PLUGIN_MANIFEST_PATHS,
  catalogPaths: CATALOG_PATHS,
  detectCatalogSource: (raw) => {
    if (typeof raw === 'string') return true;
    if (!isPlainObject(raw)) return false;
    const disc = raw.source;
    return typeof disc === 'string' && CLAUDE_GIT_DISCRIMINATORS.has(disc);
  },
  normalizeCatalogSource: normalizeClaudeCatalogSource,
  normalizePluginManifest: normalizeClaudePluginManifest,
};

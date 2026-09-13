// formats.test.ts — conformance tests for the format adapter layer (plan 531).
//
// Fixtures are trimmed copies of REAL captured artifacts, so upstream format
// drift shows up here instead of as an empty marketplace tab:
//   - Claude Code: anthropics/claude-plugins-official (295 plugins,
//     52 string / 154 url / 89 git-subdir), fetched 2026-09-13
//   - Codex: openai/plugins (.codex-plugin/plugin.json + .agents/plugins/
//     marketplace.json), fetched 2026-09-13

import { describe, it, expect } from 'vitest';

import {
  adapterForCatalogPath,
  adapterForManifestPath,
  allCatalogPaths,
  allPluginManifestPaths,
  detectCatalogSourceFormat,
  getAdapter,
  isNativeManifestPath,
  listAdapters,
  normalizeCatalogPolicy,
  normalizeCatalogSource,
  normalizePluginManifest,
} from '../src/formats/index';

// ---------------------------------------------------------------------------
// Registry / location tables
// ---------------------------------------------------------------------------

describe('format registry', () => {
  it('registers the four known ecosystems in priority order', () => {
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toEqual(['duya', 'claude-code', 'codex', 'cursor']);
  });

  it('exposes every plugin manifest path, duya native first', () => {
    expect(allPluginManifestPaths()).toEqual([
      '.duya-plugin/plugin.json',
      'plugin.json',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
    ]);
  });

  it('exposes every catalog path', () => {
    const paths = allCatalogPaths();
    expect(paths).toContain('marketplace.json');
    expect(paths).toContain('.claude-plugin/marketplace.json');
    expect(paths).toContain('.agents/plugins/marketplace.json');
    expect(paths).toContain('.cursor-plugin/marketplace.json');
  });

  it('resolves the owning adapter for each manifest path', () => {
    expect(adapterForManifestPath('.duya-plugin/plugin.json')?.id).toBe('duya');
    expect(adapterForManifestPath('plugin.json')?.id).toBe('duya');
    expect(adapterForManifestPath('.claude-plugin/plugin.json')?.id).toBe('claude-code');
    expect(adapterForManifestPath('.codex-plugin/plugin.json')?.id).toBe('codex');
    expect(adapterForManifestPath('.cursor-plugin/plugin.json')?.id).toBe('cursor');
    expect(adapterForManifestPath('.claude-plugin\\plugin.json')?.id).toBe('claude-code');
  });

  it('resolves the owning adapter for catalog paths', () => {
    expect(adapterForCatalogPath('.claude-plugin/marketplace.json')?.id).toBe('claude-code');
    expect(adapterForCatalogPath('.agents/plugins/marketplace.json')?.id).toBe('codex');
  });

  it('flags the native layout', () => {
    expect(isNativeManifestPath('.duya-plugin/plugin.json')).toBe(true);
    expect(isNativeManifestPath('plugin.json')).toBe(true);
    expect(isNativeManifestPath('.codex-plugin/plugin.json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

describe('claude-code adapter — catalog source', () => {
  it('maps a string relative path to a local source', () => {
    expect(normalizeCatalogSource('./plugins/agent-sdk-dev')).toEqual({
      source: 'local',
      path: './plugins/agent-sdk-dev',
    });
  });

  it('maps a git-URL string to a git source', () => {
    expect(normalizeCatalogSource('https://github.com/acme/plugin.git')).toEqual({
      source: 'git',
      url: 'https://github.com/acme/plugin.git',
    });
    expect(normalizeCatalogSource('github:acme/plugin')).toEqual({
      source: 'git',
      url: 'github:acme/plugin',
    });
  });

  it('maps git-subdir to git and folds ref into ref_name', () => {
    // Real entry from anthropics/claude-plugins-official.
    const out = normalizeCatalogSource({
      source: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });
    expect(out).toEqual({
      source: 'git',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref_name: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    });
  });

  it('maps a whole-repo url source to git', () => {
    expect(
      normalizeCatalogSource({
        source: 'url',
        url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
        sha: 'b280f6346fa70aaf4fbd0e0bc5d18582c1fb039a',
      }),
    ).toEqual({
      source: 'git',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      sha: 'b280f6346fa70aaf4fbd0e0bc5d18582c1fb039a',
    });
  });

  it('reports the claude-code adapter as the detector', () => {
    expect(detectCatalogSourceFormat('./plugins/x')?.id).toBe('claude-code');
    expect(detectCatalogSourceFormat({ source: 'git-subdir', url: 'u' })?.id).toBe('claude-code');
  });
});

describe('claude-code adapter — plugin manifest', () => {
  it('normalizes the real minimal manifest and defaults version', () => {
    const out = normalizePluginManifest('.claude-plugin/plugin.json', {
      name: 'agent-sdk-dev',
      description: 'Claude Agent SDK Development Plugin',
      author: { name: 'Anthropic', email: 'support@anthropic.com' },
    });
    expect(out.name).toBe('agent-sdk-dev');
    expect(out.version).toBe('0.0.0');
    expect(out.description).toBe('Claude Agent SDK Development Plugin');
    expect(out.author).toEqual({ name: 'Anthropic', email: 'support@anthropic.com' });
    expect(out.keywords).toEqual([]);
  });

  it('throws when name is missing', () => {
    expect(() =>
      normalizePluginManifest('.claude-plugin/plugin.json', { description: 'no name' }),
    ).toThrow(/name/);
  });

  it('accepts a bare string author', () => {
    const out = normalizePluginManifest('.claude-plugin/plugin.json', {
      name: 'x',
      author: 'Someone',
    });
    expect(out.author).toEqual({ name: 'Someone' });
  });
});

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

describe('codex adapter — plugin manifest', () => {
  it('normalizes the real figma manifest, mapping composerIcon to icon', () => {
    // Trimmed from openai/plugins/plugins/figma/.codex-plugin/plugin.json.
    const out = normalizePluginManifest('.codex-plugin/plugin.json', {
      name: 'figma',
      version: '2.0.20',
      description: 'Figma workflows for design implementation.',
      author: { name: 'Figma', url: 'https://www.figma.com' },
      homepage: 'https://www.figma.com',
      repository: 'https://github.com/openai/plugins',
      license: 'LicenseRef-Figma-Developer-Terms',
      keywords: ['figma', 'design'],
      skills: './skills/',
      apps: './.app.json',
      interface: {
        displayName: 'Figma',
        shortDescription: 'Figma design-to-code workflows',
        category: 'Creativity',
        brandColor: '#1ABCFE',
        composerIcon: './assets/logo-padded.png',
        logo: './assets/logo-padded.png',
        screenshots: [],
      },
    });

    expect(out.name).toBe('figma');
    expect(out.version).toBe('2.0.20');
    expect(out.author).toEqual({ name: 'Figma', url: 'https://www.figma.com' });
    expect(out.license).toBe('LicenseRef-Figma-Developer-Terms');
    expect(out.keywords).toEqual(['figma', 'design']);
    expect(out.interface?.displayName).toBe('Figma');
    expect(out.interface?.category).toBe('Creativity');
    expect(out.interface?.brandColor).toBe('#1ABCFE');
    // The whole point: Codex has no `icon`; it has composerIcon/logo.
    expect(out.interface?.icon).toBe('./assets/logo-padded.png');
    // Empty screenshot arrays are dropped rather than surfaced as [].
    expect(out.interface?.screenshots).toBeUndefined();
    expect(out.declared).toEqual({ skills: './skills/', apps: './.app.json' });
  });

  it('captures path-string capability pointers (notion-style mcpServers)', () => {
    const out = normalizePluginManifest('.codex-plugin/plugin.json', {
      name: 'notion',
      version: '0.1.7',
      mcpServers: './.mcp.json',
      skills: './skills/',
      apps: './.app.json',
      interface: { displayName: 'Notion' },
    });
    expect(out.declared).toEqual({
      mcpServers: './.mcp.json',
      skills: './skills/',
      apps: './.app.json',
    });
  });

  it('omits `declared` when the manifest has no capability pointers', () => {
    const out = normalizePluginManifest('.codex-plugin/plugin.json', { name: 'bare' });
    expect(out.declared).toBeUndefined();
    expect(out.version).toBe('0.0.0');
  });
});

describe('codex catalog policy — uppercase enums', () => {
  it('folds Codex UPPERCASE policy values to duya canonical lowercase', () => {
    // Real entry from openai/plugins/.agents/plugins/marketplace.json.
    expect(
      normalizeCatalogPolicy({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' }),
    ).toEqual({ installation: 'available', authentication: 'on_install' });
    expect(normalizeCatalogPolicy({ installation: 'INSTALLED_BY_DEFAULT' })).toEqual({
      installation: 'installed_by_default',
    });
    expect(normalizeCatalogPolicy({ installation: 'NOT_AVAILABLE' })).toEqual({
      installation: 'not_available',
    });
  });

  it('passes already-lowercase values through (duya / Claude)', () => {
    expect(
      normalizeCatalogPolicy({ installation: 'available', authentication: 'on_use' }),
    ).toEqual({ installation: 'available', authentication: 'on_use' });
  });

  it('drops unknown policy values instead of propagating them', () => {
    expect(normalizeCatalogPolicy({ installation: 'BOGUS' })).toBeUndefined();
    expect(normalizeCatalogPolicy(undefined)).toBeUndefined();
    expect(normalizeCatalogPolicy('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// duya native adapter
// ---------------------------------------------------------------------------

describe('duya adapter — catalog source', () => {
  it('normalizes the native local source', () => {
    expect(normalizeCatalogSource({ source: 'local', path: './plugins/canvas' })).toEqual({
      source: 'local',
      path: './plugins/canvas',
    });
  });

  it('normalizes the native git source and accepts ref as an alias', () => {
    expect(
      normalizeCatalogSource({ source: 'git', url: 'https://x/y.git', ref: 'v1' }),
    ).toEqual({ source: 'git', url: 'https://x/y.git', ref_name: 'v1' });
    expect(
      normalizeCatalogSource({
        source: 'git',
        url: 'https://x/y.git',
        path: 'sub',
        ref_name: 'v2',
        sha: 'abc',
      }),
    ).toEqual({ source: 'git', url: 'https://x/y.git', path: 'sub', ref_name: 'v2', sha: 'abc' });
  });

  it('rejects an unknown source shape', () => {
    expect(() => normalizeCatalogSource({ source: 'wat' })).toThrow(/recognizes/);
  });
});

describe('duya adapter — plugin manifest', () => {
  it('reads the full duya interface block', () => {
    const out = normalizePluginManifest('.duya-plugin/plugin.json', {
      name: 'canvas',
      version: '0.1.0',
      description: 'Canvas control guide',
      author: { name: 'DUYA Team' },
      interface: {
        displayName: '画布控制',
        shortDescription_en: 'ignored',
        category: 'development',
        brandColor: '#4F46E5',
        icon: './assets/icon.svg',
        displayName_zh: '画布控制',
        screenshots: ['a.png', 'b.png'],
        defaultPrompt: ['control the canvas'],
      },
    });
    expect(out.name).toBe('canvas');
    expect(out.interface?.displayName).toBe('画布控制');
    expect(out.interface?.icon).toBe('./assets/icon.svg');
    expect(out.interface?.displayName_zh).toBe('画布控制');
    expect(out.interface?.screenshots).toEqual(['a.png', 'b.png']);
    expect(out.interface?.defaultPrompt).toEqual(['control the canvas']);
  });

  it('falls back to the duya adapter when no path is given', () => {
    const out = normalizePluginManifest(undefined, { name: 'root-manifest' });
    expect(out.name).toBe('root-manifest');
    expect(out.version).toBe('0.0.0');
  });
});

// ---------------------------------------------------------------------------
// Cursor adapter (shares Claude's structure)
// ---------------------------------------------------------------------------

describe('cursor adapter', () => {
  it('hoists top-level displayName/logo/category into the interface block', () => {
    // Trimmed from cursor/plugins/advisor/.cursor-plugin/plugin.json. Cursor
    // keeps every presentation field at the TOP LEVEL — there is no
    // `interface` block at all, which is why cursor needs its own normalizer.
    const out = normalizePluginManifest('.cursor-plugin/plugin.json', {
      name: 'advisor',
      displayName: 'Advisor',
      version: '1.0.0',
      description: 'Consult a stronger model at key checkpoints.',
      author: { name: 'Cursor', email: 'plugins@cursor.com' },
      homepage: 'https://github.com/cursor/plugins/tree/main/advisor',
      repository: 'https://github.com/cursor/plugins',
      license: 'MIT',
      logo: 'assets/avatar.png',
      category: 'developer-tools',
      keywords: ['advisor', 'second-opinion'],
      tags: ['agents', 'quality'],
      skills: './skills/',
      agents: './agents/',
      rules: './rules/',
    });
    expect(out.name).toBe('advisor');
    expect(out.version).toBe('1.0.0');
    expect(out.author).toEqual({ name: 'Cursor', email: 'plugins@cursor.com' });
    expect(out.license).toBe('MIT');
    expect(out.keywords).toEqual(['advisor', 'second-opinion']);
    expect(out.interface?.displayName).toBe('Advisor');
    expect(out.interface?.category).toBe('developer-tools');
    expect(out.interface?.icon).toBe('assets/avatar.png');
    expect(out.declared).toEqual({
      skills: './skills/',
      agents: './agents/',
      rules: './rules/',
    });
  });

  it('maps a bare (no ./) catalog source to a local path', () => {
    // cursor/plugins/.cursor-plugin/marketplace.json uses bare strings.
    expect(normalizeCatalogSource('teaching')).toEqual({
      source: 'local',
      path: 'teaching',
    });
  });

  it('is reachable by id', () => {
    expect(getAdapter('cursor')?.label).toBe('Cursor');
  });
});

/**
 * Plan 492 P4.4 — create_agent / update_agent / send_to_agent catalog
 * tests (mirrors the image_generate discoverability suite).
 *
 * Proves the exposure contract the 490 comparison called out:
 *   - all three bot-collaboration tools are registered as deferred;
 *   - a bare '*' bot profile does NOT see them (plan 496: wildcards never
 *     promote — this was the SendMessage blindspot);
 *   - a bot profile whose allowlist went through applyBotToolset DOES see
 *     them from turn one (exact-name promotion);
 *   - a main-session '*' profile stays quiet (no promotion).
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinRegistry } from '../../builtin.js';
import { ToolCatalogTool } from '../../ToolCatalogTool/ToolCatalogTool.js';
import { isToolVisible, type ToolVisibilityConstraints } from '../../../agent-profile/ToolFilter.js';
import { applyBotToolset, BOT_TOOLSET } from '../../../agent-profile/bot-toolset.js';
import type { AgentProfile } from '../../../agent-profile/types.js';

const BOT_TOOLS = ['send_to_agent', 'create_agent', 'update_agent'] as const;

const NO_CONSTRAINTS: ToolVisibilityConstraints = {
  disabledTools: [],
  allowedTools: [],
  profileDisallowedPatterns: [],
  profileAllowedPatterns: [],
};

function botConstraints(allowedTools?: string[], disallowedTools?: string[]): ToolVisibilityConstraints {
  const profile = applyBotToolset({
    id: 'bot-test',
    name: 'Bot',
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    allowedTools,
    disallowedTools,
    createdAt: 0,
    updatedAt: 0,
  } as AgentProfile);
  return {
    profileAllowedPatterns: profile.allowedTools,
    profileDisallowedPatterns: profile.disallowedTools,
  };
}

describe('bot collaboration tools discoverability (plan 492 P4.4)', () => {
  it('registers all three tools as deferred in the builtin registry', () => {
    const registry = createBuiltinRegistry();
    for (const name of BOT_TOOLS) {
      expect(registry.getTool(name)).toBeDefined();
      expect(registry.getExposure(name)).toBe('deferred');
    }
  });

  it('is hidden from the default tool surface (no discovery, no promotion)', () => {
    const registry = createBuiltinRegistry();
    const visible = registry
      .getAllTools()
      .filter((t) => isToolVisible(t.name, registry.getExposure(t.name), new Set(), NO_CONSTRAINTS))
      .map((t) => t.name);
    for (const name of BOT_TOOLS) {
      expect(visible).not.toContain(name);
    }
  });

  it('is NOT promoted by a bare "*" allowlist (plan 496 wildcard rule)', () => {
    const registry = createBuiltinRegistry();
    const star: ToolVisibilityConstraints = {
      ...NO_CONSTRAINTS,
      profileAllowedPatterns: ['*'],
    };
    for (const name of BOT_TOOLS) {
      expect(
        isToolVisible(name, registry.getExposure(name), new Set(), star),
      ).toBe(false);
    }
  });

  it('IS promoted from turn one on a bot profile allowlist (applyBotToolset)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*']);
    for (const name of BOT_TOOLS) {
      expect(
        isToolVisible(name, registry.getExposure(name), new Set(), constraints),
      ).toBe(true);
    }
  });

  it('still honors an explicit deny from the bot config (deny wins)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*'], ['create_agent']);
    expect(
      isToolVisible('create_agent', registry.getExposure('create_agent'), new Set(), constraints),
    ).toBe(false);
    expect(
      isToolVisible('update_agent', registry.getExposure('update_agent'), new Set(), constraints),
    ).toBe(true);
  });
});

describe('image_generate bot exposure (2026-09-05 membership decision)', () => {
  it('is registered deferred in the builtin registry', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTool('image_generate')).toBeDefined();
    expect(registry.getExposure('image_generate')).toBe('deferred');
  });

  it('IS promoted from turn one on a bot profile (BOT_TOOLSET exact-name)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*']);
    expect(
      isToolVisible('image_generate', registry.getExposure('image_generate'), new Set(), constraints),
    ).toBe(true);
  });

  it('stays off the direct tool list on plain profiles (bare * does not promote deferred tools)', () => {
    const registry = createBuiltinRegistry();
    const star: ToolVisibilityConstraints = {
      ...NO_CONSTRAINTS,
      profileAllowedPatterns: ['*'],
    };
    expect(
      isToolVisible('image_generate', registry.getExposure('image_generate'), new Set(), star),
    ).toBe(false);
  });
});

describe('ReactToMessage exposure (plan 490 P1)', () => {
  it('is registered deferred in the builtin registry (off the direct surface)', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTool('ReactToMessage')).toBeDefined();
    expect(registry.getExposure('ReactToMessage')).toBe('deferred');
  });

  it('is reachable by stable ID through the deferred catalog path', async () => {
    const registry = createBuiltinRegistry();
    const catalog = registry.getExecutor('tool_catalog');
    if (!(catalog instanceof ToolCatalogTool)) throw new Error('builtin registry is missing tool_catalog');
    const snapshot = registry.snapshot(new Map());
    catalog.setView({
      snapshot,
      registry,
      eligibleToolIds: new Set(snapshot.catalogEntries.map((entry) => entry.toolId)),
      directToolIds: new Set(snapshot.catalogEntries.filter((entry) => entry.exposure === 'eager').map((entry) => entry.toolId)),
      loadedSchemaRevisions: new Map(),
      loadedSchemaRounds: new Map(),
      currentRound: 0,
    });
    const result = await catalog.execute({ query: 'ReactToMessage' });
    expect(result.result).toContain('"name":"ReactToMessage"');
    expect(result.result).toContain('"invocation":"tool_invoke"');
  });

  it('is NOT in BOT_TOOLSET (not a bot-only capability)', () => {
    expect(BOT_TOOLSET).not.toContain('ReactToMessage');
  });
});

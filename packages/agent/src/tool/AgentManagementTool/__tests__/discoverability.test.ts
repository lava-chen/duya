/**
 * Plan 492 P4.4 — create_agent / update_agent / send_to_agent discoverability
 * tests (mirrors the image_generate discoverability suite).
 *
 * Proves the exposure contract the 490 comparison called out:
 *   - all three bot-collaboration tools are registered 'discoverable';
 *   - a bare '*' bot profile does NOT see them (plan 496: wildcards never
 *     promote — this was the SendMessage blindspot);
 *   - a bot profile whose allowlist went through applyBotToolset DOES see
 *     them from turn one (exact-name promotion);
 *   - a main-session '*' profile stays quiet (no promotion).
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinRegistry } from '../../builtin.js';
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
  it('registers all three tools as discoverable in the builtin registry', () => {
    const registry = createBuiltinRegistry();
    for (const name of BOT_TOOLS) {
      expect(registry.getTool(name)).toBeDefined();
      expect(registry.getExposeMode(name)).toBe('discoverable');
    }
  });

  it('is hidden from the default tool surface (no discovery, no promotion)', () => {
    const registry = createBuiltinRegistry();
    const visible = registry
      .getAllTools()
      .filter((t) => isToolVisible(t.name, registry.getExposeMode(t.name), new Set(), NO_CONSTRAINTS))
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
        isToolVisible(name, registry.getExposeMode(name), new Set(), star),
      ).toBe(false);
    }
  });

  it('IS promoted from turn one on a bot profile allowlist (applyBotToolset)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*']);
    for (const name of BOT_TOOLS) {
      expect(
        isToolVisible(name, registry.getExposeMode(name), new Set(), constraints),
      ).toBe(true);
    }
  });

  it('still honors an explicit deny from the bot config (deny wins)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*'], ['create_agent']);
    expect(
      isToolVisible('create_agent', registry.getExposeMode('create_agent'), new Set(), constraints),
    ).toBe(false);
    expect(
      isToolVisible('update_agent', registry.getExposeMode('update_agent'), new Set(), constraints),
    ).toBe(true);
  });
});

describe('image_generate bot exposure (2026-09-05 membership decision)', () => {
  it('is registered discoverable in the builtin registry', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTool('image_generate')).toBeDefined();
    expect(registry.getExposeMode('image_generate')).toBe('discoverable');
  });

  it('IS promoted from turn one on a bot profile (BOT_TOOLSET exact-name)', () => {
    const registry = createBuiltinRegistry();
    const constraints = botConstraints(['*']);
    expect(
      isToolVisible('image_generate', registry.getExposeMode('image_generate'), new Set(), constraints),
    ).toBe(true);
  });

  it('stays hidden on plain profiles (bare * does not promote discoverables)', () => {
    const registry = createBuiltinRegistry();
    const star: ToolVisibilityConstraints = {
      ...NO_CONSTRAINTS,
      profileAllowedPatterns: ['*'],
    };
    expect(
      isToolVisible('image_generate', registry.getExposeMode('image_generate'), new Set(), star),
    ).toBe(false);
  });
});

describe('ReactToMessage exposure (plan 490 P1)', () => {
  it('is registered always-exposed in the builtin registry (grok SAND_FORCED_STATIC parity)', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTool('ReactToMessage')).toBeDefined();
    expect(registry.getExposeMode('ReactToMessage')).toBe('always');
  });

  it('is visible on the default surface without any bot toolset', () => {
    const registry = createBuiltinRegistry();
    expect(
      isToolVisible('ReactToMessage', registry.getExposeMode('ReactToMessage'), new Set(), NO_CONSTRAINTS),
    ).toBe(true);
  });

  it('is NOT in BOT_TOOLSET (always-exposed, not a bot-only capability)', () => {
    expect(BOT_TOOLSET).not.toContain('ReactToMessage');
  });
});

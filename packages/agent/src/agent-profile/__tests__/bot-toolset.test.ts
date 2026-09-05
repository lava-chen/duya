/**
 * Plan 481 P1.2 — bot toolset declaration tests.
 *
 * Covers the canonical BOT_TOOLSET membership and the applyBotToolset
 * merge semantics wired into toAgentProfile (config.toml [agents.<id>]).
 */

import { describe, expect, it } from 'vitest';
import { applyBotToolset, BOT_TOOLSET } from '../bot-toolset.js';
import type { AgentProfile } from '../types.js';

function makeProfile(allowedTools?: string[], disallowedTools?: string[]): AgentProfile {
  return {
    id: 'alpha',
    name: 'Alpha',
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    allowedTools,
    disallowedTools,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('BOT_TOOLSET', () => {
  it('contains the plan 477 DM tool and the plan 481 update_state tool', () => {
    expect(BOT_TOOLSET).toContain('send_to_agent');
    expect(BOT_TOOLSET).toContain('update_state');
  });

  it('contains the plan 492 self-management tools', () => {
    expect(BOT_TOOLSET).toContain('create_agent');
    expect(BOT_TOOLSET).toContain('update_agent');
  });

  it('contains image_generate (grok static-surface parity, 2026-09-05)', () => {
    expect(BOT_TOOLSET).toContain('image_generate');
  });

  it('does not claim the always-exposed ReactToMessage (plan 490 P1)', () => {
    expect(BOT_TOOLSET).not.toContain('ReactToMessage');
  });

  it('does not claim the always-exposed meta tools (T4/T5)', () => {
    expect(BOT_TOOLSET).not.toContain('tool_schema');
    expect(BOT_TOOLSET).not.toContain('tool_invoke');
  });
});

describe('applyBotToolset', () => {
  it('appends the bot toolset to a restricted base allowlist', () => {
    const merged = applyBotToolset(makeProfile(['file:read*', 'search:*']));
    for (const tool of BOT_TOOLSET) {
      expect(merged.allowedTools).toContain(tool);
    }
    expect(merged.allowedTools).toContain('file:read*');
  });

  it('is idempotent — no duplicates on re-application', () => {
    const once = applyBotToolset(makeProfile(['file:read*']));
    const twice = applyBotToolset(once);
    expect(twice.allowedTools.filter((t) => t === 'update_state')).toHaveLength(1);
  });

  it('appends the bot toolset to a "*" allowlist (plan 496 exposure promotion)', () => {
    // The default `full` base profile resolves to ['*']. The exact names must
    // still be appended: ToolFilter only promotes a discoverable tool on an
    // exact allowlist entry, so a bare '*' bot never saw SendMessage.
    const merged = applyBotToolset(makeProfile(['*']));
    expect(merged.allowedTools).toContain('*');
    for (const tool of BOT_TOOLSET) {
      expect(merged.allowedTools).toContain(tool);
    }
  });

  it('treats an undefined allowlist as no-op', () => {
    const merged = applyBotToolset(makeProfile(undefined));
    expect(merged.allowedTools).toBeUndefined();
  });

  it('never touches deny entries', () => {
    const merged = applyBotToolset(makeProfile(['file:read*'], ['update_state']));
    expect(merged.disallowedTools).toEqual(['update_state']);
  });
});

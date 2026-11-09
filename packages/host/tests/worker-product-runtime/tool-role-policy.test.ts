/**
 * Regression: role-restricted product toolsets must not leak into an
 * ordinary Session's tool catalog.
 *
 * The builtin registry is shared process-wide, so the deny list is injected
 * per turn into ToolVisibilityConstraints. Deny is evaluated before both the
 * catalog-router shortcut and the allowlist in isToolVisible, which is why
 * ONE deny set narrows the direct tools[] array, tool_catalog's eligible
 * set, and tool_invoke's dispatcher (wired to eligibleToolIds) together.
 *
 * Every "should be hidden" assertion has a paired "without the policy it
 * would be visible" counterexample — a test that only checks the positive
 * side would stay green if the deny list were never wired up.
 */

import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '@duya/agent-core';
import { isToolVisible, type ToolVisibilityConstraints } from '@duya/agent-runtime/authorization/tool-filter';
import {
  BOT_ONLY_TOOL_NAMES,
  COORDINATOR_ONLY_TOOL_NAMES,
  resolveRoleRestrictedToolDeny,
  resolveToolRole,
} from '../../src/worker-profiles/tool-role-policy.js';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'general-purpose',
    name: 'General',
    kind: 'main',
    allowedTools: ['*'],
    userVisible: true,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const COORDINATOR = profile({
  id: 'project-coordinator',
  isPreset: true,
  allowedTools: ['session', 'project', 'todo'],
  userVisible: false,
});
const BOT = profile({
  id: 'my-bot',
  isPreset: false,
  allowedTools: ['*', 'send_message', 'send_to_agent'],
});
const ORDINARY = profile();

/** The per-turn shape produced in _resolveTools after this policy landed. */
function turnConstraints(p: AgentProfile, applyPolicy: boolean): ToolVisibilityConstraints {
  const role = resolveToolRole(p, !p.isPreset && p.kind === 'main');
  const deny = applyPolicy
    ? resolveRoleRestrictedToolDeny(role, p.allowedTools)
    : [];
  return {
    profileAllowedPatterns: p.allowedTools,
    ...(p.disallowedTools?.length || deny.length
      ? { profileDisallowedPatterns: [...(p.disallowedTools ?? []), ...deny] }
      : {}),
  };
}

describe('resolveToolRole', () => {
  it('recognises the Coordinator by its product identity, not by a string literal at the call site', () => {
    expect(resolveToolRole(COORDINATOR, false)).toBe('coordinator');
  });

  it('recognises config-driven bots and keeps presets as ordinary Sessions', () => {
    expect(resolveToolRole(BOT, true)).toBe('bot');
    expect(resolveToolRole(ORDINARY, false)).toBe('session');
    expect(resolveToolRole(undefined, false)).toBe('session');
  });

  it('Coordinator identity wins over a bot-shaped profile', () => {
    expect(resolveToolRole({ ...COORDINATOR, isPreset: false }, true)).toBe('coordinator');
  });
});

describe('resolveRoleRestrictedToolDeny', () => {
  it('an ordinary Session (wildcard allowlist) is denied BOTH restricted families', () => {
    const deny = resolveRoleRestrictedToolDeny('session', ['*']);
    expect(deny).toEqual(expect.arrayContaining(COORDINATOR_ONLY_TOOL_NAMES));
    expect(deny).toEqual(expect.arrayContaining(BOT_ONLY_TOOL_NAMES));
  });

  it('a wildcard is NOT an authorization — the exact-count counterexample', () => {
    // Without the exact-name escape hatch this assertion is meaningless:
    // a '*' entry must not skip the deny just because it "allows everything".
    const wildcard = resolveRoleRestrictedToolDeny('session', ['*']);
    const explicit = resolveRoleRestrictedToolDeny('session', ['*', 'send_message']);
    expect(wildcard).toContain('send_message');
    expect(explicit).not.toContain('send_message');
    expect(wildcard.length - explicit.length).toBe(1);
  });

  it('the Coordinator keeps `project` but loses the bot channels', () => {
    const deny = resolveRoleRestrictedToolDeny('coordinator', COORDINATOR.allowedTools);
    expect(deny).not.toContain('project');
    expect(deny).toContain('send_message');
  });

  it('a bot keeps its collaboration channels but loses `project`', () => {
    const deny = resolveRoleRestrictedToolDeny('bot', ['*', 'send_message', 'send_to_agent']);
    expect(deny).not.toContain('send_message');
    expect(deny).not.toContain('send_to_agent');
    expect(deny).toContain('project');
  });

  it('an explicit exact allowlist entry overrides the role deny for ordinary Sessions too', () => {
    const deny = resolveRoleRestrictedToolDeny('session', ['*', 'create_agent', 'project']);
    expect(deny).not.toContain('create_agent');
    expect(deny).not.toContain('project');
    expect(deny).toContain('send_message');
  });
});

describe('per-turn visibility — the leak is closed on BOTH the direct array and the catalog', () => {
  it('counterexample: before the policy, an ordinary Session could discover and invoke `project`', () => {
    const before = turnConstraints(ORDINARY, false);
    expect(isToolVisible('project', 'deferred', new Set(), before)).toBe(false); // not promoted to direct
    expect(isToolVisible('project', 'eager', new Set(), before)).toBe(true); // ...but catalog-eligible
  });

  it('after the policy, `project` is out of the catalog eligible set as well', () => {
    const after = turnConstraints(ORDINARY, true);
    expect(isToolVisible('project', 'deferred', new Set(), after)).toBe(false);
    expect(isToolVisible('project', 'eager', new Set(), after)).toBe(false);
  });

  it('after the policy, bot channels are out of an ordinary Session catalog', () => {
    const after = turnConstraints(ORDINARY, true);
    for (const name of BOT_ONLY_TOOL_NAMES) {
      expect(isToolVisible(name, 'eager', new Set(), after), name).toBe(false);
    }
  });

  it('counterexample: before the policy every bot channel was catalog-visible to `*`', () => {
    const before = turnConstraints(ORDINARY, false);
    for (const name of BOT_ONLY_TOOL_NAMES) {
      expect(isToolVisible(name, 'eager', new Set(), before), name).toBe(true);
    }
  });

  it('the Coordinator still sees `project`, and a bot still sees its voice', () => {
    const coordinator = turnConstraints(COORDINATOR, true);
    expect(isToolVisible('project', 'eager', new Set(), coordinator)).toBe(true);
    const bot = turnConstraints(BOT, true);
    expect(isToolVisible('send_message', 'eager', new Set(), bot)).toBe(true);
    // BOT_TOOLSET exact-name promotion must still work for bots.
    expect(isToolVisible('send_message', 'deferred', new Set(), bot)).toBe(true);
  });

  it('unrestricted tools are untouched — the policy must not hollow out the toolset', () => {
    const after = turnConstraints(ORDINARY, true);
    for (const name of ['read', 'write', 'bash', 'todo', 'tool_catalog', 'tool_invoke']) {
      expect(isToolVisible(name, 'eager', new Set(), after), name).toBe(true);
    }
  });
});

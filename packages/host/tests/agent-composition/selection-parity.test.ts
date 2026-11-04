/**
 * Plan 624 slice C1 — parity for the three resolvers that replaced inline
 * decisions in the session.
 *
 * Each case compares the resolver against the expression it replaced, so a
 * future edit that "tidies" one side shows up as a failing assertion instead
 * of a silent prompt or permission change.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PERMISSION_MODE,
  resolveModeSelection,
  resolvePermissionSelection,
  resolveToolSelection,
} from '@duya/host/agent-composition';
import { collectActiveModes } from '@duya/host/worker-modes/modifiers/apply-modes';
import type { AgentProfile } from '@duya/agent-core';

const lookup = {
  get: (id: string) => (id === 'plan' ? { orchestrator: {} } : id === 'goal' ? {} : undefined),
};

describe('plan 624 — mode selection parity', () => {
  it('matches collectActiveModes across normal, empty, unknown and known modes', () => {
    for (const mode of [undefined, '', 'normal', 'plan', 'goal', 'unknown-mode']) {
      const legacy = collectActiveModes({ ...(mode !== undefined ? { mode } : {}) });
      const resolved = resolveModeSelection({ ...(mode !== undefined ? { mode } : {}) }, lookup);
      expect(resolved.activeModeIds).toEqual(legacy);
    }
  });

  it('matches the orchestrator predicate the session used to apply', () => {
    for (const mode of [undefined, '', 'normal', 'plan', 'goal', 'unknown-mode']) {
      const requested = mode || 'normal';
      const legacyId = requested === 'normal' ? null : (lookup.get(requested)?.orchestrator ? requested : null);
      expect(resolveModeSelection({ ...(mode !== undefined ? { mode } : {}) }, lookup).orchestratorModeId ?? null)
        .toBe(legacyId);
    }
  });
});

describe('plan 624 — permission selection parity', () => {
  it('matches the live || assignment', () => {
    for (const permissionMode of [undefined, '', 'default', 'acceptEdits', 'bypassPermissions']) {
      const legacy = permissionMode || 'default';
      expect(resolvePermissionSelection({ ...(permissionMode !== undefined ? { permissionMode } : {}) }).permissionMode)
        .toBe(legacy);
    }
  });

  it('names the host default when nothing was declared', () => {
    expect(resolvePermissionSelection({}).permissionMode).toBe(DEFAULT_PERMISSION_MODE);
  });
});

describe('plan 624 — tool selection parity', () => {
  const profile: AgentProfile = {
    id: 'p',
    name: 'P',
    kind: 'main',
    isPreset: true,
    userVisible: true,
    isEnabled: true,
    allowedTools: ['*'],
    createdAt: 0,
    updatedAt: 0,
  };

  it('matches definedProperties omission for absent lists', () => {
    const resolved = resolveToolSelection(profile);

    expect(resolved.profileAllowedPatterns).toEqual(['*']);
    expect(resolved.profileDisallowedPatterns).toBeUndefined();
    expect(resolved.turnAllowedTools).toBeUndefined();
    expect(resolved.turnDisabledTools).toBeUndefined();
  });

  it('keeps an explicitly empty turn list distinct from an absent one', () => {
    expect(resolveToolSelection(profile, { allowedTools: [] }).turnAllowedTools).toEqual([]);
    expect(resolveToolSelection(profile).turnAllowedTools).toBeUndefined();
  });
});

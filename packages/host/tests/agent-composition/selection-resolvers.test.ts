/**
 * Plan 624 slice A1b — the four selection resolvers.
 *
 * These pin the decisions that `beginTurnAssembly` currently makes inline
 * (tool constraints, mode set, permission mode, cache family) so slice A2 can
 * shadow-compare them against the live values.
 */

import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_CACHE_BREAKPOINTS,
  DEFAULT_PERMISSION_MODE,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  resolveCacheSelection,
  resolveModeSelection,
  resolvePermissionSelection,
  resolveToolSelection,
} from '@duya/host/agent-composition';
import { MAIN_AGENT_PROFILES } from '@duya/host/worker-profiles';
import type { AgentProfile } from '@duya/agent-core';

const codeExpert = MAIN_AGENT_PROFILES.find((profile) => profile.id === 'code-expert') as AgentProfile;

describe('plan 624 — tool selection', () => {
  it('records profile patterns and turn overrides separately', () => {
    const selection = resolveToolSelection(codeExpert, { disabledTools: ['bash'] });

    expect(selection.profileAllowedPatterns).toEqual(['*']);
    expect(selection.profileDisallowedPatterns).toContain('show_widget');
    expect(selection.turnDisabledTools).toEqual(['bash']);
    expect(selection.decisions.map((d) => d.field)).toEqual([
      'tools.profileAllowed',
      'tools.profileDisallowed',
      'tools.turnDisabled',
    ]);
  });

  it('says "unconstrained" explicitly instead of leaving the decision implicit', () => {
    const selection = resolveToolSelection(undefined);

    expect(selection.decisions).toEqual([
      {
        field: 'tools.constraints',
        value: 'none',
        source: 'host-default',
        note: expect.any(String),
      },
    ]);
  });

  it('copies arrays so a caller cannot mutate the profile', () => {
    const selection = resolveToolSelection(codeExpert);
    selection.profileAllowedPatterns.push('mutated');

    expect(codeExpert.allowedTools).not.toContain('mutated');
  });
});

describe('plan 624 — mode selection', () => {
  it('applies no modifier in normal mode', () => {
    const selection = resolveModeSelection({ mode: 'normal' });

    expect(selection.activeModeIds).toEqual([]);
    expect(selection.orchestratorModeId).toBeUndefined();
    expect(selection.decisions[0]?.source).toBe('host-default');
  });

  it('treats a missing or empty mode as normal', () => {
    expect(resolveModeSelection({}).activeModeIds).toEqual([]);
    expect(resolveModeSelection({ mode: '' }).activeModeIds).toEqual([]);
  });

  it('records the orchestrator only when the registry says so', () => {
    const plain = resolveModeSelection({ mode: 'goal' }, { get: () => ({}) });
    expect(plain.activeModeIds).toEqual(['goal']);
    expect(plain.orchestratorModeId).toBeUndefined();

    const orchestrated = resolveModeSelection({ mode: 'plan' }, { get: () => ({ orchestrator: {} }) });
    expect(orchestrated.orchestratorModeId).toBe('plan');
  });
});

describe('plan 624 — permission selection', () => {
  it('prefers the turn override', () => {
    const selection = resolvePermissionSelection({ permissionMode: 'bypassPermissions' });

    expect(selection.permissionMode).toBe('bypassPermissions');
    expect(selection.decisions[0]?.source).toBe('turn-override');
  });

  it('falls back to default for a missing or empty mode, matching the live || assignment', () => {
    for (const input of [{}, { permissionMode: '' }]) {
      const selection = resolvePermissionSelection(input);
      expect(selection.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
      expect(selection.decisions[0]?.source).toBe('host-default');
    }
  });
});

describe('plan 624 — cache selection', () => {
  it('gives the Anthropic family the breakpoint budget and no OpenAI key', () => {
    const selection = resolveCacheSelection({ protocol: 'anthropic', sessionId: 's-1' });

    expect(selection.family).toBe('anthropic-messages');
    expect(selection.cacheControlBreakpoints).toBe(ANTHROPIC_CACHE_BREAKPOINTS);
    expect(selection.promptCacheKey).toBeUndefined();
  });

  it('derives the OpenAI key from the session id and clamps it', () => {
    const sessionId = 'x'.repeat(100);
    const selection = resolveCacheSelection({ protocol: 'openai', api: 'responses', sessionId });

    expect(selection.family).toBe('openai-responses');
    expect(selection.promptCacheKey).toHaveLength(MAX_PROMPT_CACHE_KEY_LENGTH);
    expect(selection.cacheControlBreakpoints).toBe(0);
  });

  it('distinguishes responses from chat and never emits a key for other protocols', () => {
    expect(resolveCacheSelection({ protocol: 'openai', api: 'chat' }).family).toBe('openai-chat');
    expect(resolveCacheSelection({ protocol: 'openai' }).family).toBe('openai-chat');

    const none = resolveCacheSelection({ protocol: 'other', sessionId: 's-1' });
    expect(none.family).toBe('none');
    expect(none.promptCacheKey).toBeUndefined();
  });

  it('refuses to invent a key when the session is unknown', () => {
    const selection = resolveCacheSelection({ protocol: 'openai', api: 'responses' });

    expect(selection.promptCacheKey).toBeUndefined();
    expect(selection.decisions.some((d) => d.field === 'cache.promptCacheKey' && d.source === 'host-default')).toBe(true);
  });
});

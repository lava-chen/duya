/**
 * Plan 624 slice A1 — the composition layer's IO-free decisions.
 *
 * Two claims are pinned here:
 *   - every preset and config-driven agent resolves to exactly one scope, and
 *   - the prompt system a profile runs is explained, not inferred.
 *
 * Nothing in this file touches the live assembly; it asserts the resolver that
 * slice A2 will shadow-compare against `WorkerSession._buildSystemPrompt`.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveCompositionScope,
  resolvePromptSelection,
  type CompositionDecision,
} from '@duya/host/agent-composition';
import {
  MAIN_AGENT_PROFILES,
  SPECIAL_AGENT_PROFILES,
  SUBAGENT_AGENT_PROFILES,
} from '@duya/host/worker-profiles';
import { PROJECT_COORDINATOR_PROFILE_ID } from '@duya/host/project/identity';
import type { AgentProfile } from '@duya/agent-core';

function profileById(id: string): AgentProfile {
  const found = [...MAIN_AGENT_PROFILES, ...SUBAGENT_AGENT_PROFILES, ...SPECIAL_AGENT_PROFILES]
    .find((profile) => profile.id === id);
  if (!found) throw new Error(`missing preset profile: ${id}`);
  return found;
}

function configAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'my-bot',
    name: 'My Bot',
    kind: 'main',
    isPreset: false,
    userVisible: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function field(decisions: readonly CompositionDecision[], name: string): CompositionDecision | undefined {
  return decisions.find((item) => item.field === name);
}

describe('plan 624 — composition scope', () => {
  it('maps every preset to its scope', () => {
    const actual = [...MAIN_AGENT_PROFILES, ...SUBAGENT_AGENT_PROFILES, ...SPECIAL_AGENT_PROFILES]
      .map((profile) => [profile.id, resolveCompositionScope(profile).scope]);

    expect(actual).toEqual([
      [PROJECT_COORDINATOR_PROFILE_ID, 'coordinator'],
      ['general-purpose', 'main-session'],
      ['code-expert', 'main-session'],
      ['research', 'main-session'],
      ['explore', 'subagent'],
      ['plan', 'subagent'],
      ['gateway', 'special'],
      ['cron', 'special'],
      ['memory-curator', 'special'],
    ]);
  });

  it('recognizes a config-driven agent as a bot before the main-session branch', () => {
    const resolved = resolveCompositionScope(configAgent());

    // A config agent is `kind: 'main'`; if the bot check were not first it
    // would fall through to main-session and lose its bot assembly.
    expect(resolved.scope).toBe('bot');
    expect(field(resolved.decisions, 'scope')).toEqual({
      field: 'scope',
      value: 'bot',
      source: 'config',
      note: expect.stringContaining('[agents.<id>]'),
    });
  });

  it('keeps presets out of the bot scope', () => {
    for (const profile of [...MAIN_AGENT_PROFILES, ...SUBAGENT_AGENT_PROFILES, ...SPECIAL_AGENT_PROFILES]) {
      expect(resolveCompositionScope(profile).scope).not.toBe('bot');
    }
  });
});

describe('plan 624 — prompt selection', () => {
  it('uses the declared prompt system and records it as a profile decision', () => {
    const selection = resolvePromptSelection(profileById('code-expert'));

    expect(selection.promptSystem).toBe('code');
    expect(selection.requestedSystem).toBe('code');
    expect(field(selection.decisions, 'prompt.system')).toEqual({
      field: 'prompt.system',
      value: 'code',
      source: 'profile',
    });
  });

  it('records the general fallback for a subagent instead of pretending it declared one', () => {
    const selection = resolvePromptSelection(profileById('explore'));

    expect(selection.promptSystem).toBe('general');
    expect(selection.requestedSystem).toBeUndefined();
    expect(field(selection.decisions, 'prompt.system')?.source).toBe('fallback');
    expect(selection.disableSections).toContain('memory');
  });

  it('carries the coordinator identity suppression', () => {
    const selection = resolvePromptSelection(profileById(PROJECT_COORDINATOR_PROFILE_ID));

    expect(selection.promptSystem).toBe('project');
    expect(selection.suppressIdentityBlock).toBe(true);
  });

  it('flags the bot assembly path so the double source stays visible', () => {
    const selection = resolvePromptSelection(configAgent());

    expect(selection.usesBotAssembly).toBe(true);
    expect(field(selection.decisions, 'prompt.botAssembly')?.source).toBe('config');
  });

  it('falls back to the host default when no profile is applied', () => {
    const selection = resolvePromptSelection(undefined);

    expect(selection.promptSystem).toBe('general');
    expect(selection.usesBotAssembly).toBe(false);
    expect(field(selection.decisions, 'prompt.system')?.source).toBe('host-default');
  });

  it('copies section overrides instead of aliasing the profile arrays', () => {
    const profile = configAgent({ promptProfile: { disableSections: ['memory'] } });
    const selection = resolvePromptSelection(profile);

    expect(selection.disableSections).toEqual(['memory']);
    expect(selection.disableSections).not.toBe(profile.promptProfile?.disableSections);
  });
});

/**
 * Plan 624 slice B1 — parity between the composition resolver and the code it
 * replaced.
 *
 * `_buildSystemPrompt` now reads the prompt system, the identity suppression
 * and the bot-assembly flag from `resolvePromptSelection`. These assertions
 * pin that the resolver agrees with the three predicates it replaced, for
 * every preset and for a config-driven agent, so the switch is provably
 * byte-neutral rather than merely plausible.
 */

import { describe, expect, it } from 'vitest';

import { resolvePromptSelection } from '@duya/host/agent-composition';
import { getPromptProfileForAgentProfile, resolvePromptSystemName } from '@duya/host/worker-prompts/index';
import { isBotAgentProfile } from '@duya/host/worker-prompts/bot/loader';
import {
  MAIN_AGENT_PROFILES,
  SPECIAL_AGENT_PROFILES,
  SUBAGENT_AGENT_PROFILES,
} from '@duya/host/worker-profiles';
import type { AgentProfile } from '@duya/agent-core';

const configAgent: AgentProfile = {
  id: 'parity-bot',
  name: 'Parity Bot',
  kind: 'main',
  isPreset: false,
  userVisible: true,
  isEnabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const allProfiles = [
  ...MAIN_AGENT_PROFILES,
  ...SUBAGENT_AGENT_PROFILES,
  ...SPECIAL_AGENT_PROFILES,
  configAgent,
];

describe('plan 624 — prompt selection parity', () => {
  it('agrees with resolvePromptSystemName for every profile', () => {
    for (const profile of allProfiles) {
      expect(resolvePromptSelection(profile).promptSystem).toBe(resolvePromptSystemName(profile.promptSystem));
    }
  });

  it('agrees with getPromptProfileForAgentProfile on the section lists', () => {
    for (const profile of allProfiles) {
      const selection = resolvePromptSelection(profile);
      const legacy = getPromptProfileForAgentProfile(profile);

      expect(selection.enableSections).toEqual(legacy.enableSections ?? []);
      expect(selection.disableSections).toEqual(legacy.disableSections ?? []);
    }
  });

  it('agrees with isBotAgentProfile, including the config agent', () => {
    for (const profile of allProfiles) {
      expect(resolvePromptSelection(profile).usesBotAssembly).toBe(isBotAgentProfile(profile));
    }
    expect(resolvePromptSelection(configAgent).usesBotAssembly).toBe(true);
  });

  it('agrees with the identity-suppression predicate', () => {
    for (const profile of allProfiles) {
      expect(resolvePromptSelection(profile).suppressIdentityBlock).toBe(profile.suppressIdentityBlock === true);
    }
  });

  it('keeps the no-profile default identical to the legacy fallback', () => {
    const selection = resolvePromptSelection(undefined);

    expect(selection.promptSystem).toBe(resolvePromptSystemName(undefined));
    expect(selection.suppressIdentityBlock).toBe(false);
    expect(selection.usesBotAssembly).toBe(isBotAgentProfile(undefined));
  });
});

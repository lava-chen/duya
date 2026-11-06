/**
 * Plan 624 v2 G2 — the section plan closes the bot double track.
 */
import { describe, expect, it } from 'vitest';

import { resolveSectionPlan } from '@duya/host/agent-composition';
import {
  BOT_ASSEMBLY_SECTION_IDS,
  sectionsForConfig,
} from '@duya/host/worker-prompts/sections/placement-registry';
import { MAIN_AGENT_PROFILES } from '@duya/host/worker-profiles';
import type { AgentProfile } from '@duya/agent-core';

const mainProfile = MAIN_AGENT_PROFILES.find((profile) => profile.isPreset) as AgentProfile;
const botProfile: AgentProfile = {
  ...mainProfile,
  id: 'custom-config-bot',
  kind: 'main',
  isPreset: false,
  promptSystem: undefined,
};

describe('plan 624 v2 — resolveSectionPlan', () => {
  it('gives a non-bot scope only PromptSystem sections', () => {
    const plan = resolveSectionPlan(mainProfile);
    expect(plan.botSections).toEqual([]);
    expect(plan.configSections).toEqual(sectionsForConfig(plan.promptSystem));
    expect(plan.decisions.find((d) => d.field === 'sections.assembly')?.value).toBe('none');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.configSections)).toBe(true);
  });

  it('gives a bot scope the assembly sections as the single bot track', () => {
    const plan = resolveSectionPlan(botProfile);
    expect(plan.botSections).toEqual([...BOT_ASSEMBLY_SECTION_IDS]);
    expect(plan.configSections).toEqual(sectionsForConfig(plan.promptSystem));
    expect(plan.decisions.find((d) => d.field === 'sections.assembly')?.value)
      .toBe(`bot:${BOT_ASSEMBLY_SECTION_IDS.length}`);
  });

  it('has no profile case, which still resolves to a plan', () => {
    const plan = resolveSectionPlan();
    expect(plan.promptSystem).toBe('general');
    expect(plan.botSections).toEqual([]);
    expect(plan.configSections.length).toBeGreaterThan(0);
  });

  it('matches the real bot section catalog order', async () => {
    const { BOT_SECTION_CATALOG } = await import('@duya/host/worker-prompts/bot/catalog');
    expect([...BOT_ASSEMBLY_SECTION_IDS]).toEqual(BOT_SECTION_CATALOG.map((section) => section.name));
  });
});

/**
 * Tests for sub-agent profile → prompt section resolution.
 *
 * Verifies that the `promptProfile.disableSections` configured on
 * PRESET_AGENT_PROFILES (explore, plan, research, general-purpose, gateway)
 * actually removes those sections from `resolveEnabledSections` output.
 *
 * This is the integration boundary: the preset's intent ("explore should
 * not see memory") reaches the runtime through `getPromptProfileForAgentProfile`
 * + `resolveEnabledSections`. A break at any link in that chain is caught here.
 */

import { describe, it, expect } from 'vitest';
import {
  PRESET_AGENT_PROFILES,
} from '../../../src/agent-profile/types.js';
import {
  getPromptProfileForAgentProfile,
  resolveEnabledSections,
} from '../../../src/prompts/modes/index.js';

function findPreset(id: string) {
  const p = PRESET_AGENT_PROFILES.find(x => x.id === id);
  if (!p) throw new Error(`preset ${id} not found in PRESET_AGENT_PROFILES`);
  return p;
}

describe('PRESET_AGENT_PROFILES → resolveEnabledSections', () => {
  it('explore disables memory, skills, sessionGuidance, visionGuidelines', () => {
    const profile = findPreset('explore');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('memory')).toBe(false);
    expect(enabled.has('memoryContent')).toBe(false);
    expect(enabled.has('skills')).toBe(false);
    expect(enabled.has('sessionGuidance')).toBe(false);
    expect(enabled.has('visionGuidelines')).toBe(false);

    // Sanity: intro/system should still be on.
    expect(enabled.has('intro')).toBe(true);
    expect(enabled.has('system')).toBe(true);
  });

  it('plan disables the same sections as explore', () => {
    const profile = findPreset('plan');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('memory')).toBe(false);
    expect(enabled.has('memoryContent')).toBe(false);
    expect(enabled.has('skills')).toBe(false);
    expect(enabled.has('sessionGuidance')).toBe(false);
    expect(enabled.has('visionGuidelines')).toBe(false);
  });

  it('research disables taskHandling and actions', () => {
    const profile = findPreset('research');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('taskHandling')).toBe(false);
    expect(enabled.has('actions')).toBe(false);

    // Sanity: intro/system should still be on.
    expect(enabled.has('intro')).toBe(true);
    expect(enabled.has('system')).toBe(true);
  });

  it('general-purpose disables taskHandling but enables generalTaskGuidance', () => {
    const profile = findPreset('general-purpose');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('taskHandling')).toBe(false);
    // generalTaskGuidance is re-enabled by the preset's enableSections override
    // — even if not in DEFAULT_BASE_SECTION_SETS.full, the override wins.
    // (When the section isn't in the base registry, the override adds it to
    // the resolved set, so isSectionEnabled should return true.)
    expect(enabled.has('generalTaskGuidance')).toBe(true);
  });

  it('gateway disables memory, sessionGuidance, skills', () => {
    const profile = findPreset('gateway');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('memory')).toBe(false);
    expect(enabled.has('memoryContent')).toBe(false);
    expect(enabled.has('sessionGuidance')).toBe(false);
    expect(enabled.has('skills')).toBe(false);
    expect(enabled.has('agentsMd')).toBe(false);
    expect(enabled.has('projectGrounding')).toBe(false);
    expect(enabled.has('projectContinuity')).toBe(false);

    // Sanity: intro/system should still be on.
    expect(enabled.has('intro')).toBe(true);
    expect(enabled.has('system')).toBe(true);
  });

  it('cron disables actions (no user to ask for confirmation)', () => {
    const profile = findPreset('cron');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    expect(enabled.has('actions')).toBe(false);
    // Sanity: core sections should still be on.
    expect(enabled.has('intro')).toBe(true);
    expect(enabled.has('system')).toBe(true);
    expect(enabled.has('toolUsage')).toBe(true);
  });

  it('code-expert has no overrides, all base sections stay enabled', () => {
    const profile = findPreset('code-expert');
    const promptProfile = getPromptProfileForAgentProfile(profile);
    const enabled = resolveEnabledSections(promptProfile);

    // Code-expert doesn't override anything — defaults to 'full'.
    expect(enabled.has('intro')).toBe(true);
    expect(enabled.has('system')).toBe(true);
    expect(enabled.has('taskHandling')).toBe(true);
    expect(enabled.has('actions')).toBe(true);
    expect(enabled.has('toolUsage')).toBe(true);
    expect(enabled.has('memory')).toBe(true);
    expect(enabled.has('agentsMd')).toBe(true);
    expect(enabled.has('projectGrounding')).toBe(true);
    expect(enabled.has('projectContinuity')).toBe(true);
    expect(enabled.has('environment')).toBe(true);
  });
});

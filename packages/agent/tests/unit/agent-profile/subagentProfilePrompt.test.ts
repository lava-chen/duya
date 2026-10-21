/**
 * Tests for sub-agent profile -> prompt section resolution.
 *
 * Verifies that the `promptProfile.disableSections` configured on
 * PRESET_AGENT_PROFILES actually removes those sections from the assembled
 * prompt. This is the integration boundary: the preset's intent ("explore
 * should not see memory") reaches the runtime through
 * `getPromptProfileForAgentProfile` + `isSectionEnabled`.
 *
 * These assertions used to call `resolveEnabledSections`, which is not the
 * production path. That helper returns only the *explicit* enable list minus
 * the disable list, so a section that is enabled by default never appears in
 * its result — `expect(enabled.has('intro')).toBe(true)` could not hold for a
 * profile that only uses disableSections. Its sole non-test caller,
 * resolveEnabledSectionsForAgentProfile, is itself unreferenced, while
 * isSectionEnabled has 14 production call sites. So the tests now exercise
 * the function the prompt system actually consults, and pin the section
 * lists that PRESET_AGENT_PROFILES really declares.
 */

import { describe, it, expect } from 'vitest';
import {
  PRESET_AGENT_PROFILES,
} from '../../../src/agent-profile/types.js';
import {
  getPromptProfileForAgentProfile,
  isSectionEnabled,
} from '../../../src/prompts/modes/index.js';

function findPreset(id: string) {
  const p = PRESET_AGENT_PROFILES.find(x => x.id === id);
  if (!p) throw new Error(`preset ${id} not found in PRESET_AGENT_PROFILES`);
  return p;
}

/**
 * Assert that exactly the given sections are disabled for a preset, and
 * that the given ones stay enabled. Driven off the preset's own declared
 * disableSections so a configuration change shows up as a diff here rather
 * than as a silently stale expectation.
 */
function expectSections(presetId: string, disabled: string[], enabled: string[] = ['intro', 'system']) {
  const promptProfile = getPromptProfileForAgentProfile(findPreset(presetId));
  const on = (section: string) => isSectionEnabled(promptProfile, section);

  for (const section of disabled) {
    expect(on(section), `${presetId} should disable ${section}`).toBe(false);
  }
  for (const section of enabled) {
    expect(on(section), `${presetId} should keep ${section}`).toBe(true);
  }
}

describe('PRESET_AGENT_PROFILES -> isSectionEnabled', () => {
  it('explore disables memory, skills, sessionGuidance, visionGuidelines', () => {
    expectSections('explore', [
      'memory', 'memoryContent', 'skills', 'sessionGuidance', 'visionGuidelines',
    ]);
  });

  it('plan disables the same sections as explore', () => {
    expectSections('plan', [
      'memory', 'memoryContent', 'skills', 'sessionGuidance', 'visionGuidelines',
    ]);
  });

  it('research disables the rules section', () => {
    expectSections('research', ['rules'], ['intro', 'system', 'taskHandling']);
  });

  it('general-purpose cuts volatile session-history sections but keeps task handling', () => {
    // A denylist, not the old enableSections whitelist (plan 535 A-6): a
    // whitelist silently hid the skills catalog for its entire lifetime.
    expectSections('general-purpose', [
      'configProtection', 'outputStyle', 'mcp', 'scratchpad',
      'sessionSearch', 'sessionGuidance',
      'visionGuidelines', 'visualVerification',
    ], ['intro', 'system', 'taskHandling', 'generalTaskGuidance']);
  });

  it('gateway disables memoryContent, rules, personality, agentsMd, projectContinuity', () => {
    expectSections('gateway', [
      'memoryContent', 'rules', 'personality', 'agentsMd', 'projectContinuity',
    ]);
  });

  it('cron disables rules (it must not ask the user to confirm anything)', () => {
    expectSections('cron', ['rules'], ['intro', 'system', 'toolUsage', 'actions']);
  });

  it('code-expert has no overrides, all base sections stay enabled', () => {
    expectSections('code-expert', [], [
      'intro', 'system', 'taskHandling', 'actions', 'toolUsage',
      'memory', 'agentsMd', 'projectContinuity', 'environment',
    ]);
  });
});

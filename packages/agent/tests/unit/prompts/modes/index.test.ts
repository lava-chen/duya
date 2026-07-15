import { describe, it, expect } from 'vitest';
import {
  resolveEnabledSections,
  isSectionEnabled,
  DEFAULT_PROMPT_PROFILE,
  SUBAGENT_TYPE_PROFILE_MAP,
  getPromptProfileForSubagentType,
  DEFAULT_BASE_SECTION_SETS,
  OVERLAY_SECTION_PATCHES,
} from '../../../../src/prompts/modes/index.js';
import type { PromptProfile } from '../../../../src/prompts/modes/types.js';

describe('prompt modes', () => {
  describe('DEFAULT_PROMPT_PROFILE', () => {
    it('should default to full mode', () => {
      expect(DEFAULT_PROMPT_PROFILE.base).toBe('full');
      expect(DEFAULT_PROMPT_PROFILE.overlays).toBeUndefined();
      expect(DEFAULT_PROMPT_PROFILE.overrides).toBeUndefined();
    });
  });

  describe('DEFAULT_BASE_SECTION_SETS', () => {
    it('full mode should enable all governance sections', () => {
      const full = DEFAULT_BASE_SECTION_SETS.full;
      expect(full.enable).toContain('intro');
      expect(full.enable).toContain('system');
      expect(full.enable).toContain('taskHandling');
      expect(full.enable).toContain('actions');
      expect(full.enable).toContain('toolUsage');
      expect(full.enable).toContain('toneAndStyle');
      expect(full.enable).toContain('outputEfficiency');
      expect(full.enable).toContain('memory');
      expect(full.enable).toContain('skills');
      expect(full.enable).toContain('mcp');
      expect(full.enable).toContain('sessionGuidance');
      expect(full.enable).toContain('agentsMd');
      expect(full.enable).toContain('projectGrounding');
      expect(full.enable).toContain('projectContinuity');
      expect(full.enable).toContain('environment');
      expect(full.enable).toContain('sessionSearch');
      expect(full.enable).toContain('recentSessions');
      expect(full.disable).toEqual([]);
    });

    it('minimal mode should keep essential project grounding without coordinator governance', () => {
      const minimal = DEFAULT_BASE_SECTION_SETS.minimal;
      expect(minimal.enable).toEqual([
        'intro', 'system', 'projectGrounding', 'agentsMd', 'actions',
        'toolUsage', 'visualVerification', 'environment', 'language',
      ]);
      expect(minimal.disable).toContain('memory');
      expect(minimal.disable).toContain('skills');
      expect(minimal.disable).toContain('sessionGuidance');
      expect(minimal.disable).toContain('projectContinuity');
      expect(minimal.disable).toContain('recentSessions');
    });

    it('bare mode should retain project instructions without main-agent continuity', () => {
      const bare = DEFAULT_BASE_SECTION_SETS.bare;
      expect(bare.enable).toEqual([
        'intro', 'system', 'projectGrounding', 'agentsMd', 'actions',
        'toolUsage', 'environment', 'language',
      ]);
      expect(bare.disable).toContain('memory');
      expect(bare.disable).toContain('skills');
      expect(bare.disable).toContain('sessionGuidance');
      expect(bare.disable).toContain('projectContinuity');
      expect(bare.disable).toContain('recentSessions');
      expect(bare.disable).toContain('toneAndStyle');
    });

    it('bare mode should still retain safety guardrails (intro, system, actions)', () => {
      const bare = DEFAULT_BASE_SECTION_SETS.bare;
      expect(bare.enable).toContain('intro');
      expect(bare.enable).toContain('system');
      expect(bare.enable).toContain('actions');
      expect(bare.enable).toContain('toolUsage');
    });
  });

  describe('resolveEnabledSections', () => {
    it('full mode should enable all sections', () => {
      const profile: PromptProfile = { base: 'full' };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('taskHandling')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);
      expect(enabled.has('toneAndStyle')).toBe(true);
      expect(enabled.has('outputEfficiency')).toBe(true);
      expect(enabled.has('memory')).toBe(true);
      expect(enabled.has('skills')).toBe(true);
      expect(enabled.has('mcp')).toBe(true);
      expect(enabled.has('sessionGuidance')).toBe(true);
      expect(enabled.has('agentsMd')).toBe(true);
      expect(enabled.has('projectGrounding')).toBe(true);
      expect(enabled.has('projectContinuity')).toBe(true);
      expect(enabled.has('recentSessions')).toBe(true);
      expect(enabled.has('environment')).toBe(true);
    });

    it('minimal mode should only enable essential sections', () => {
      const profile: PromptProfile = { base: 'minimal' };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);
      expect(enabled.has('projectGrounding')).toBe(true);
      expect(enabled.has('agentsMd')).toBe(true);
      expect(enabled.has('environment')).toBe(true);
      expect(enabled.has('language')).toBe(true);

      expect(enabled.has('taskHandling')).toBe(false);
      expect(enabled.has('toneAndStyle')).toBe(false);
      expect(enabled.has('outputEfficiency')).toBe(false);
      expect(enabled.has('memory')).toBe(false);
      expect(enabled.has('skills')).toBe(false);
      expect(enabled.has('mcp')).toBe(false);
      expect(enabled.has('sessionGuidance')).toBe(false);
      expect(enabled.has('projectContinuity')).toBe(false);
      expect(enabled.has('recentSessions')).toBe(false);
    });

    it('bare mode should not have toneAndStyle', () => {
      const profile: PromptProfile = { base: 'bare' };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);
      expect(enabled.has('projectGrounding')).toBe(true);
      expect(enabled.has('agentsMd')).toBe(true);
      expect(enabled.has('environment')).toBe(true);

      expect(enabled.has('toneAndStyle')).toBe(false);
      expect(enabled.has('memory')).toBe(false);
      expect(enabled.has('skills')).toBe(false);
      expect(enabled.has('sessionGuidance')).toBe(false);
      expect(enabled.has('recentSessions')).toBe(false);
    });

    it('coding overlay should add taskHandling and outputEfficiency', () => {
      const profile: PromptProfile = { base: 'minimal', overlays: ['coding'] };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('taskHandling')).toBe(true);
      expect(enabled.has('outputEfficiency')).toBe(true);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);

      expect(enabled.has('memory')).toBe(false);
      expect(enabled.has('skills')).toBe(false);
    });

    it('chat overlay should add toneAndStyle', () => {
      const profile: PromptProfile = { base: 'minimal', overlays: ['chat'] };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('toneAndStyle')).toBe(true);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);

      expect(enabled.has('taskHandling')).toBe(false);
      expect(enabled.has('outputEfficiency')).toBe(false);
    });

    it('multiple overlays should combine correctly', () => {
      const profile: PromptProfile = { base: 'bare', overlays: ['coding', 'chat'] };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('taskHandling')).toBe(true);
      expect(enabled.has('outputEfficiency')).toBe(true);
      expect(enabled.has('toneAndStyle')).toBe(true);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);

      expect(enabled.has('memory')).toBe(false);
      expect(enabled.has('skills')).toBe(false);
      expect(enabled.has('sessionGuidance')).toBe(false);
    });

    it('overrides should enable specific sections', () => {
      const profile: PromptProfile = {
        base: 'minimal',
        overrides: { enableSections: ['memory'] },
      };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('memory')).toBe(true);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(true);
    });

    it('overrides should disable specific sections', () => {
      const profile: PromptProfile = {
        base: 'full',
        overrides: { disableSections: ['memory', 'skills'] },
      };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('memory')).toBe(false);
      expect(enabled.has('skills')).toBe(false);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
    });

    it('overrides enable + disable should work together', () => {
      const profile: PromptProfile = {
        base: 'minimal',
        overrides: {
          enableSections: ['memory'],
          disableSections: ['toolUsage'],
        },
      };
      const enabled = resolveEnabledSections(profile);

      expect(enabled.has('memory')).toBe(true);
      expect(enabled.has('toolUsage')).toBe(false);
      expect(enabled.has('intro')).toBe(true);
      expect(enabled.has('system')).toBe(true);
      expect(enabled.has('actions')).toBe(true);
    });
  });

  describe('isSectionEnabled', () => {
    it('should return true for enabled sections', () => {
      const profile: PromptProfile = { base: 'full' };
      expect(isSectionEnabled(profile, 'intro')).toBe(true);
      expect(isSectionEnabled(profile, 'memory')).toBe(true);
    });

    it('should return false for disabled sections', () => {
      const profile: PromptProfile = { base: 'minimal' };
      expect(isSectionEnabled(profile, 'memory')).toBe(false);
      expect(isSectionEnabled(profile, 'skills')).toBe(false);
    });
  });

  describe('SUBAGENT_TYPE_PROFILE_MAP', () => {
    it('Explore should map to minimal', () => {
      expect(SUBAGENT_TYPE_PROFILE_MAP.Explore).toEqual({ base: 'minimal' });
      expect(SUBAGENT_TYPE_PROFILE_MAP.explore).toEqual({ base: 'minimal' });
    });

    it('research should map to minimal', () => {
      expect(SUBAGENT_TYPE_PROFILE_MAP.research).toEqual({ base: 'minimal' });
    });

    it('verification should map to full', () => {
      expect(SUBAGENT_TYPE_PROFILE_MAP.verification).toEqual({ base: 'full' });
    });

    it('fork should map to bare', () => {
      expect(SUBAGENT_TYPE_PROFILE_MAP.fork).toEqual({ base: 'bare' });
    });
  });

  describe('getPromptProfileForSubagentType', () => {
    it('should return minimal for undefined subagent type', () => {
      const profile = getPromptProfileForSubagentType(undefined);
      expect(profile).toEqual({ base: 'minimal' });
    });

    it('should return mapped profile for known subagent types', () => {
      expect(getPromptProfileForSubagentType('Explore')).toEqual({ base: 'minimal' });
      expect(getPromptProfileForSubagentType('verification')).toEqual({ base: 'full' });
      expect(getPromptProfileForSubagentType('fork')).toEqual({ base: 'bare' });
    });

    it('should return minimal for unknown subagent types', () => {
      expect(getPromptProfileForSubagentType('unknown')).toEqual({ base: 'minimal' });
      expect(getPromptProfileForSubagentType('custom-agent')).toEqual({ base: 'minimal' });
    });
  });
});

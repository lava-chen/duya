/**
 * Tests for Conditional Skills
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PromptSkill } from '../../src/skills/types.js';
import {
  activateConditionalSkills,
  getPendingConditionalSkills,
  getPendingConditionalSkillCount,
  isSkillActivated,
  clearConditionalSkills,
  getActivatedSkillNames,
  isConditionalSkill,
  separateConditionalSkills,
  registerConditionalSkill,
} from '../../src/skills/conditionalSkills.js';

describe('conditionalSkills', () => {
  beforeEach(() => {
    clearConditionalSkills();
  });

  describe('isConditionalSkill', () => {
    it('should return true for skill with paths not yet activated', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*', 'docker-compose*.yml'],
        async getPromptForCommand() { return ''; },
      };

      expect(isConditionalSkill(skill)).toBe(true);
    });

    it('should return false for skill without paths', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'general-help',
        description: 'General help',
        source: 'user',
        async getPromptForCommand() { return ''; },
      };

      expect(isConditionalSkill(skill)).toBe(false);
    });

    it('should return false for skill with empty paths array', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'empty-paths',
        description: 'Empty paths',
        source: 'user',
        paths: [],
        async getPromptForCommand() { return ''; },
      };

      expect(isConditionalSkill(skill)).toBe(false);
    });
  });

  describe('separateConditionalSkills', () => {
    it('should separate unconditional and conditional skills', () => {
      const unconditionalSkill: PromptSkill = {
        type: 'prompt',
        name: 'general-help',
        description: 'General help',
        source: 'user',
        async getPromptForCommand() { return ''; },
      };

      const conditionalSkill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        async getPromptForCommand() { return ''; },
      };

      const [unconditional, conditional] = separateConditionalSkills([
        unconditionalSkill,
        conditionalSkill,
      ]);

      expect(unconditional).toHaveLength(1);
      expect(unconditional[0].name).toBe('general-help');
      expect(conditional).toHaveLength(1);
      expect(conditional[0].name).toBe('docker-deploy');
    });
  });

  describe('activateConditionalSkills', () => {
    it('should activate skill when file matches pattern', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      // Register as conditional
      registerConditionalSkill(skill);

      // Activate with matching file
      const activated = activateConditionalSkills(['Dockerfile']);

      expect(activated).toContain('docker-deploy');
      expect(isSkillActivated('docker-deploy')).toBe(true);
      expect(skill.isConditional).toBe(false);
    });

    it('should activate skill with globstar pattern', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'react-component',
        description: 'React component dev',
        source: 'user',
        paths: ['**/*.tsx'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);

      const activated = activateConditionalSkills(['src/components/Button.tsx']);

      expect(activated).toContain('react-component');
    });

    it('should not activate skill when file does not match', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);

      const activated = activateConditionalSkills(['README.md']);

      expect(activated).toHaveLength(0);
      expect(isSkillActivated('docker-deploy')).toBe(false);
    });

    it('should activate multiple skills if multiple match', () => {
      const dockerSkill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      const composeSkill: PromptSkill = {
        type: 'prompt',
        name: 'docker-compose',
        description: 'Docker Compose',
        source: 'user',
        paths: ['docker-compose*.yml'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(dockerSkill);
      registerConditionalSkill(composeSkill);

      const activated = activateConditionalSkills(['Dockerfile', 'docker-compose.yml']);

      expect(activated).toHaveLength(2);
      expect(activated).toContain('docker-deploy');
      expect(activated).toContain('docker-compose');
    });

    it('should handle directory patterns', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'k8s-deploy',
        description: 'Kubernetes deployment',
        source: 'user',
        paths: ['**/k8s/**'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);

      const activated = activateConditionalSkills(['deployments/k8s/service.yaml']);

      expect(activated).toContain('k8s-deploy');
    });
  });

  describe('getPendingConditionalSkills', () => {
    it('should return empty array when no pending skills', () => {
      expect(getPendingConditionalSkills()).toHaveLength(0);
    });

    it('should return pending skills', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);

      const pending = getPendingConditionalSkills();

      expect(pending).toHaveLength(1);
      expect(pending[0].name).toBe('docker-deploy');
    });
  });

  describe('getPendingConditionalSkillCount', () => {
    it('should return 0 when no pending skills', () => {
      expect(getPendingConditionalSkillCount()).toBe(0);
    });

    it('should return correct count', () => {
      const skill1: PromptSkill = {
        type: 'prompt',
        name: 'skill1',
        description: 'Skill 1',
        source: 'user',
        paths: ['*.txt'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      const skill2: PromptSkill = {
        type: 'prompt',
        name: 'skill2',
        description: 'Skill 2',
        source: 'user',
        paths: ['*.md'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill1);
      registerConditionalSkill(skill2);

      expect(getPendingConditionalSkillCount()).toBe(2);
    });
  });

  describe('getActivatedSkillNames', () => {
    it('should return empty array initially', () => {
      expect(getActivatedSkillNames()).toHaveLength(0);
    });

    it('should return activated skill names', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);
      activateConditionalSkills(['Dockerfile']);

      const activated = getActivatedSkillNames();

      expect(activated).toContain('docker-deploy');
    });
  });

  describe('clearConditionalSkills', () => {
    it('should clear all conditional skill state', () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'docker-deploy',
        description: 'Docker deployment',
        source: 'user',
        paths: ['Dockerfile*'],
        isConditional: true,
        async getPromptForCommand() { return ''; },
      };

      registerConditionalSkill(skill);
      activateConditionalSkills(['Dockerfile']);

      clearConditionalSkills();

      expect(getPendingConditionalSkillCount()).toBe(0);
      expect(getActivatedSkillNames()).toHaveLength(0);
    });
  });
});

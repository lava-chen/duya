/**
 * Tests for AgentProfileService
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryAgentProfileService,
  PRESET_AGENT_PROFILES,
} from '../../../src/agent-profile/AgentProfileService.js';
import type { AgentProfile } from '../../../src/agent-profile/types.js';

describe('AgentProfileService', () => {
  let service: InMemoryAgentProfileService;

  beforeEach(() => {
    service = new InMemoryAgentProfileService();
  });

  describe('presets', () => {
    it('should load all preset agent profiles on init', () => {
      const profiles = service.list();
      expect(profiles.length).toBe(PRESET_AGENT_PROFILES.length);
    });

    it('should have General preset with all tools', () => {
      const general = service.get('general-purpose');
      expect(general).toBeDefined();
      expect(general?.name).toBe('General');
      expect(general?.allowedTools).toContain('*');
      expect(general?.userVisible).toBe(true);
    });

    it('should have Code preset with coding tools', () => {
      const code = service.get('code-expert');
      expect(code).toBeDefined();
      expect(code?.name).toBe('Code');
      expect(code?.allowedTools).toContain('*');
      expect(code?.userVisible).toBe(true);
    });

    it('should have Research preset', () => {
      const research = service.get('research');
      expect(research).toBeDefined();
      expect(research?.name).toBe('Research');
      expect(research?.userVisible).toBe(true);
    });

    it('should have Explore as hidden sub-agent-only preset', () => {
      const explore = service.get('explore');
      expect(explore).toBeDefined();
      expect(explore?.userVisible).toBe(false);
      expect(explore?.isPreset).toBe(true);
    });

    it('should have Plan as hidden sub-agent-only preset', () => {
      const plan = service.get('plan');
      expect(plan).toBeDefined();
      expect(plan?.userVisible).toBe(false);
      expect(plan?.isPreset).toBe(true);
    });

    it('should list only user-visible profiles', () => {
      const visible = service.listUserVisible();
      expect(visible.every(p => p.userVisible)).toBe(true);
      expect(visible.length).toBe(3);
      expect(visible.map(p => p.id).sort()).toEqual(['code-expert', 'general-purpose', 'research']);
    });
  });

  describe('CRUD', () => {
    it('should create a custom profile', () => {
      const profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'> = {
        id: 'my-custom-agent',
        name: 'My Custom Agent',
        description: 'A custom agent',
        allowedTools: ['file:*', 'search:*'],
        isPreset: false,
        isEnabled: true,
        userVisible: true,
      };

      const created = service.create(profile);
      expect(created.id).toBe('my-custom-agent');
      expect(created.createdAt).toBeGreaterThan(0);

      const retrieved = service.get('my-custom-agent');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('My Custom Agent');
    });

    it('should not allow creating duplicate profiles', () => {
      const profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'> = {
        id: 'my-custom-agent',
        name: 'My Custom Agent',
        isPreset: false,
        isEnabled: true,
        userVisible: true,
      };

      service.create(profile);
      expect(() => service.create(profile)).toThrow('already exists');
    });

    it('should update a custom profile', () => {
      const profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'> = {
        id: 'my-custom-agent',
        name: 'My Custom Agent',
        isPreset: false,
        isEnabled: true,
        userVisible: true,
      };

      service.create(profile);
      const updated = service.update('my-custom-agent', { name: 'Updated Name' });
      expect(updated?.name).toBe('Updated Name');
    });

    it('should not allow modifying preset profile core fields', () => {
      expect(() => service.update('explore', { name: 'Hacked' })).toThrow('Cannot modify preset profile field');
    });

    it('should allow toggling preset profile enabled state', () => {
      const updated = service.update('explore', { isEnabled: false });
      expect(updated?.isEnabled).toBe(false);
    });

    it('should delete a custom profile', () => {
      const profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'> = {
        id: 'my-custom-agent',
        name: 'My Custom Agent',
        isPreset: false,
        isEnabled: true,
        userVisible: true,
      };

      service.create(profile);
      expect(service.delete('my-custom-agent')).toBe(true);
      expect(service.get('my-custom-agent')).toBeUndefined();
    });

    it('should not delete preset profiles', () => {
      expect(() => service.delete('explore')).toThrow('Cannot delete preset profiles');
    });

    it('should list only enabled profiles', () => {
      service.update('explore', { isEnabled: false });
      const enabled = service.listEnabled();
      expect(enabled.some(p => p.id === 'explore')).toBe(false);
      expect(enabled.some(p => p.id === 'general-purpose')).toBe(true);
    });
  });
});

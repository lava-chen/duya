/**
 * Tests for Agent Identity Helpers
 */

import { describe, it, expect } from 'vitest';
import {
  getEmojiForProfile,
  getColorForProfile,
  getIdentityLabel,
} from '../../../src/agent-profile/identity.js';
import type { AgentProfile } from '../../../src/agent-profile/types.js';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test',
    name: 'Test Agent',
    isPreset: false,
    isEnabled: true,
    userVisible: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('getEmojiForProfile', () => {
  it('should return preset emoji for known profiles', () => {
    expect(getEmojiForProfile('general-purpose')).toBe('\ud83e\udd16');
    expect(getEmojiForProfile('code-expert')).toBe('\ud83d\udcbb');
    expect(getEmojiForProfile('research')).toBe('\ud83d\udd2c');
    expect(getEmojiForProfile('explore')).toBe('\ud83d\udd0d');
    expect(getEmojiForProfile('plan')).toBe('\ud83d\udcd6');
  });

  it('should return default emoji for unknown profiles', () => {
    expect(getEmojiForProfile('unknown')).toBe('\ud83e\udd16');
  });
});

describe('getColorForProfile', () => {
  it('should return preset colors for known profiles', () => {
    expect(getColorForProfile('general-purpose')).toBe('#6366f1');
    expect(getColorForProfile('code-expert')).toBe('#10b981');
    expect(getColorForProfile('explore')).toBe('#8b5cf6');
    expect(getColorForProfile('plan')).toBe('#f59e0b');
  });

  it('should return default color for unknown profiles', () => {
    expect(getColorForProfile('unknown')).toBe('#6366f1');
  });
});

describe('getIdentityLabel', () => {
  it('should format identity label', () => {
    const profile = makeProfile({
      id: 'code-expert',
      name: 'Code',
    });
    expect(getIdentityLabel(profile)).toBe('\ud83d\udcbb Code');
  });

  it('should work for general profile', () => {
    const profile = makeProfile({
      id: 'general-purpose',
      name: 'General',
    });
    expect(getIdentityLabel(profile)).toBe('\ud83e\udd16 General');
  });
});

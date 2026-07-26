import { describe, expect, it } from 'vitest';
import { isSectionEnabled } from '../../../src/prompts/modes/index.js';

describe('isSectionEnabled', () => {
  it('keeps the default profile fully enabled', () => {
    expect(isSectionEnabled({}, 'skills')).toBe(true);
  });

  it('treats an explicit enable list as a whitelist', () => {
    const profile = { enableSections: ['identity', 'tasks'] };

    expect(isSectionEnabled(profile, 'identity')).toBe(true);
    expect(isSectionEnabled(profile, 'tasks')).toBe(true);
    expect(isSectionEnabled(profile, 'skills')).toBe(false);
    expect(isSectionEnabled(profile, 'sessionGuidance')).toBe(false);
  });

  it('uses disable sections only when no whitelist is present', () => {
    expect(isSectionEnabled({ disableSections: ['skills'] }, 'skills')).toBe(false);
    expect(isSectionEnabled({ disableSections: ['skills'] }, 'tasks')).toBe(true);
  });
});

/**
 * The permission vocabulary the badge, the cycling key and `/permission` share.
 *
 * The properties worth pinning are the ones a wrong answer would hide: the
 * stored profile and the word the user reads must round-trip, and the cycle
 * must escalate and then come back — a cycle that stopped at `bypass` would
 * leave the user with no way back to the restrictive mode but the command.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_MODES,
  nextPermissionMode,
  permissionBadge,
  permissionModeFromProfile,
  profileForPermissionMode,
} from '../permission-mode.js';

describe('permission mode vocabulary', () => {
  it('maps the stored profile to the word the user reads', () => {
    expect(permissionModeFromProfile('default')).toBe('ask');
    expect(permissionModeFromProfile('auto')).toBe('auto');
    expect(permissionModeFromProfile('full_access')).toBe('bypass');
  });

  it('reads an unknown profile as ask', () => {
    // The profile comes off a database row; a value a newer build wrote must
    // not leave the composer without a mode.
    expect(permissionModeFromProfile(null)).toBe('ask');
    expect(permissionModeFromProfile(undefined)).toBe('ask');
  });

  it('round-trips every mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeFromProfile(profileForPermissionMode(mode))).toBe(mode);
    }
  });

  it('cycles ask → auto → bypass → ask', () => {
    expect(nextPermissionMode('ask')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('bypass');
    expect(nextPermissionMode('bypass')).toBe('ask');
  });
});

describe('permission badge', () => {
  it('names the mode and the key that cycles it', () => {
    const badge = permissionBadge('bypass', false);
    expect(badge.plain).toBe('[bypass]');
    expect(badge.hint).toContain('Shift+Tab');
  });

  it('paints the mode that grants everything as an error', () => {
    expect(permissionBadge('bypass', false).token).toBe('error');
    expect(permissionBadge('auto', false).token).toBe('warning');
    expect(permissionBadge('ask', false).token).toBe('muted');
  });

  it('says what the second press does while bypass waits for it', () => {
    expect(permissionBadge('bypass', true).hint).toContain('again');
    expect(permissionBadge('bypass', true).plain).toBe('[bypass]');
  });
});

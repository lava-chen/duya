/**
 * permission-profile.contract.test.ts
 *
 * Forces apps/desktop/src/main/lib/permission-profile.ts and the shared
 * packages/ui/src/lib/permission-profile.ts implementation to stay in sync
 * (the renderer copy moved into @duya/ui with the shared-renderer migration,
 * plan 610/24). Any function signature, return value, or constant drift fails.
 *
 * Both implementations must keep character-identical pure-function logic;
 * only the file location and import paths differ. The test lives next to the
 * main-process copy because that is the duplicate still being hand-maintained;
 * importing the ui package from here is a declared desktop-host -> ui edge.
 */

import { describe, it, expect } from 'vitest';
import * as electronImpl from '../lib/permission-profile';
import * as uiImpl from '@duya/ui/lib/permission-profile';

describe('permission-profile contract: electron vs shared ui', () => {
  const ELECTRON = electronImpl as typeof uiImpl;

  it('exports the same function names', () => {
    const electronNames = Object.keys(electronImpl).sort();
    const uiNames = Object.keys(uiImpl).sort();
    expect(electronNames).toEqual(uiNames);
  });

  it('settingsModeToProfile behaves identically for 12 inputs', () => {
    const cases: Array<string | null | undefined> = [
      'bypass',
      'auto',
      'default',
      'dontAsk', // legacy / invalid, both should fall back to 'default'
      'garbage',
      '',
      null,
      undefined,
      'BYPASS', // case sensitive
      'Default',
      'bypass ', // trailing whitespace
      '0',
    ];
    for (const input of cases) {
      expect(electronImpl.settingsModeToProfile(input)).toBe(uiImpl.settingsModeToProfile(input));
    }
  });

  it('profileToAgentMode behaves identically for 10 inputs', () => {
    const cases: Array<string | null | undefined> = [
      'full_access',
      'auto',
      'default',
      'garbage',
      '',
      null,
      undefined,
      'bypass', // Settings value, not profile — should fall through
      'BYPASS_PERMISSIONS',
      'auto ',
    ];
    for (const input of cases) {
      expect(electronImpl.profileToAgentMode(input)).toBe(uiImpl.profileToAgentMode(input));
    }
  });

  it('isValidProfile behaves identically', () => {
    const cases: unknown[] = ['default', 'auto', 'full_access', 'garbage', '', null, undefined, 0, true, false, {}, []];
    for (const input of cases) {
      expect(electronImpl.isValidProfile(input)).toBe(uiImpl.isValidProfile(input));
    }
  });

  it('isValidAgentMode behaves identically', () => {
    const cases: unknown[] = ['default', 'auto', 'bypassPermissions', 'garbage', '', null, undefined, 0, true, false, {}, []];
    for (const input of cases) {
      expect(electronImpl.isValidAgentMode(input)).toBe(uiImpl.isValidAgentMode(input));
    }
  });

  it('VALID_PROFILES / VALID_AGENT_MODES constants are equal', () => {
    expect(electronImpl.VALID_PROFILES).toEqual(uiImpl.VALID_PROFILES);
    expect(electronImpl.VALID_AGENT_MODES).toEqual(uiImpl.VALID_AGENT_MODES);
  });

  it('PermissionProfile / AgentPermissionMode types are structurally identical (sanity)', () => {
    // Types do not participate at runtime; a runtime check still proves the
    // exports exist on both sides.
    expect(typeof electronImpl.settingsModeToProfile).toBe(typeof uiImpl.settingsModeToProfile);
    expect(typeof electronImpl.profileToAgentMode).toBe(typeof uiImpl.profileToAgentMode);
    expect(typeof electronImpl.isValidProfile).toBe(typeof uiImpl.isValidProfile);
    expect(typeof electronImpl.isValidAgentMode).toBe(typeof uiImpl.isValidAgentMode);
  });

  it('all output values are in the documented enum (no drift)', () => {
    const profiles = ['default', 'auto', 'full_access'];
    const modes = ['default', 'auto', 'bypassPermissions'];

    for (const input of ['bypass', 'auto', 'default', 'garbage', null, undefined] as const) {
      expect(profiles).toContain(electronImpl.settingsModeToProfile(input));
      expect(profiles).toContain(uiImpl.settingsModeToProfile(input));
    }
    for (const input of ['full_access', 'auto', 'default', 'garbage', null, undefined] as const) {
      expect(modes).toContain(electronImpl.profileToAgentMode(input));
      expect(modes).toContain(uiImpl.profileToAgentMode(input));
    }
  });
});

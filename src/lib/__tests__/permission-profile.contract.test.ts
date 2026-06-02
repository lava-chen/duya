/**
 * permission-profile.contract.test.ts
 *
 * 强制 electron/lib/permission-profile.ts 与 src/lib/permission-profile.ts 两份实现同步.
 * 任何函数签名、返回值、常量漂移都会失败.
 *
 * 两份实现必须保持逐字符相同的纯函数逻辑, 仅文件位置与导入路径不同.
 */

import { describe, it, expect } from 'vitest';
import * as electronImpl from '../../../electron/lib/permission-profile';
import * as rendererImpl from '../permission-profile';

describe('permission-profile contract: electron vs renderer', () => {
  const ELECTRON = electronImpl as typeof rendererImpl;

  it('exports the same function names', () => {
    const electronNames = Object.keys(electronImpl).sort();
    const rendererNames = Object.keys(rendererImpl).sort();
    expect(electronNames).toEqual(rendererNames);
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
      expect(electronImpl.settingsModeToProfile(input)).toBe(rendererImpl.settingsModeToProfile(input));
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
      expect(electronImpl.profileToAgentMode(input)).toBe(rendererImpl.profileToAgentMode(input));
    }
  });

  it('isValidProfile behaves identically', () => {
    const cases: unknown[] = ['default', 'auto', 'full_access', 'garbage', '', null, undefined, 0, true, false, {}, []];
    for (const input of cases) {
      expect(electronImpl.isValidProfile(input)).toBe(rendererImpl.isValidProfile(input));
    }
  });

  it('isValidAgentMode behaves identically', () => {
    const cases: unknown[] = ['default', 'auto', 'bypassPermissions', 'garbage', '', null, undefined, 0, true, false, {}, []];
    for (const input of cases) {
      expect(electronImpl.isValidAgentMode(input)).toBe(rendererImpl.isValidAgentMode(input));
    }
  });

  it('VALID_PROFILES / VALID_AGENT_MODES constants are equal', () => {
    expect(electronImpl.VALID_PROFILES).toEqual(rendererImpl.VALID_PROFILES);
    expect(electronImpl.VALID_AGENT_MODES).toEqual(rendererImpl.VALID_AGENT_MODES);
  });

  it('PermissionProfile / AgentPermissionMode types are structurally identical (sanity)', () => {
    // 类型层不参与运行时, 但用一个运行时检查确保导出在两边一致.
    expect(typeof electronImpl.settingsModeToProfile).toBe(typeof rendererImpl.settingsModeToProfile);
    expect(typeof electronImpl.profileToAgentMode).toBe(typeof rendererImpl.profileToAgentMode);
    expect(typeof electronImpl.isValidProfile).toBe(typeof rendererImpl.isValidProfile);
    expect(typeof electronImpl.isValidAgentMode).toBe(typeof rendererImpl.isValidAgentMode);
  });

  it('all output values are in the documented enum (no drift)', () => {
    const profiles = ['default', 'auto', 'full_access'];
    const modes = ['default', 'auto', 'bypassPermissions'];

    for (const input of ['bypass', 'auto', 'default', 'garbage', null, undefined] as const) {
      expect(profiles).toContain(electronImpl.settingsModeToProfile(input));
      expect(profiles).toContain(rendererImpl.settingsModeToProfile(input));
    }
    for (const input of ['full_access', 'auto', 'default', 'garbage', null, undefined] as const) {
      expect(modes).toContain(electronImpl.profileToAgentMode(input));
      expect(modes).toContain(rendererImpl.profileToAgentMode(input));
    }
  });
});

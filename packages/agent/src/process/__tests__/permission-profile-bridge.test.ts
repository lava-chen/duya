/**
 * permission-profile-bridge.test.ts - 桥接函数单测 + chat:start 跨层回归
 *
 * 跨层测试覆盖:
 *   - row=full_access + options.permissionModeOverride=default → agentMode=default
 *   - row=full_access + options.permissionModeOverride=garbage → agentMode=bypassPermissions (走 row)
 *   - row=null → agentMode=default (DB 不可读降级)
 *
 * Plan 583 / ISS-09: 旧 options.permissionMode 字段已从 wire 协议删除, 相关
 * "被忽略" 断言不再需要 —— 字段不存在, 旧 sender 携带时只是多余属性.
 */

import { describe, it, expect } from 'vitest';
import {
  profileToAgentMode,
  isValidAgentMode,
  resolveChatStartAgentMode,
} from '../permission-profile-bridge.js';

describe('profileToAgentMode', () => {
  it('full_access → bypassPermissions', () => {
    expect(profileToAgentMode('full_access')).toBe('bypassPermissions');
  });

  it('auto → auto', () => {
    expect(profileToAgentMode('auto')).toBe('auto');
  });

  it('default → default', () => {
    expect(profileToAgentMode('default')).toBe('default');
  });

  it('null → default', () => {
    expect(profileToAgentMode(null)).toBe('default');
  });

  it('undefined → default', () => {
    expect(profileToAgentMode(undefined)).toBe('default');
  });

  it('garbage → default (fail closed)', () => {
    expect(profileToAgentMode('garbage')).toBe('default');
  });

  it('empty string → default', () => {
    expect(profileToAgentMode('')).toBe('default');
  });

  it('Settings 字符串 bypass 不应被错认为 profile', () => {
    expect(profileToAgentMode('bypass')).toBe('default');
  });
});

describe('isValidAgentMode', () => {
  it('valid modes', () => {
    expect(isValidAgentMode('default')).toBe(true);
    expect(isValidAgentMode('auto')).toBe(true);
    expect(isValidAgentMode('bypassPermissions')).toBe(true);
  });

  it('invalid inputs', () => {
    expect(isValidAgentMode('bypass')).toBe(false);
    expect(isValidAgentMode('full_access')).toBe(false);
    expect(isValidAgentMode('garbage')).toBe(false);
    expect(isValidAgentMode('')).toBe(false);
    expect(isValidAgentMode(null)).toBe(false);
    expect(isValidAgentMode(undefined)).toBe(false);
    expect(isValidAgentMode(0)).toBe(false);
  });
});

describe('resolveChatStartAgentMode - 跨层回归', () => {
  it('row=full_access + options.permissionModeOverride=default → agentMode=default (override 生效)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'full_access',
      optionOverride: 'default',
    });
    expect(r.agentMode).toBe('default');
    expect(r.override).toBe('default');
  });

  it('row=full_access + options.permissionModeOverride=garbage (非法) → agentMode=bypassPermissions (走 row)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'full_access',
      optionOverride: 'garbage',
    });
    expect(r.agentMode).toBe('bypassPermissions');
    expect(r.override).toBeNull();
  });

  it('row=null → agentMode=default (DB 不可读降级)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: null,
      optionOverride: undefined,
    });
    expect(r.agentMode).toBe('default');
    expect(r.fromRow).toBeNull();
  });

  it('row=undefined + options.permissionModeOverride=auto → agentMode=auto (override 生效)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: undefined,
      optionOverride: 'auto',
    });
    expect(r.agentMode).toBe('auto');
  });

  it('row=auto + 无 override → agentMode=auto', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'auto',
      optionOverride: undefined,
    });
    expect(r.agentMode).toBe('auto');
  });

  it('row=garbage (DB 异常) + 无 override → agentMode=default (fail closed)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'garbage',
      optionOverride: undefined,
    });
    expect(r.agentMode).toBe('default');
  });
});

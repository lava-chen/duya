/**
 * permission-profile-bridge.test.ts - 桥接函数单测 + chat:start 跨层回归
 *
 * 跨层测试覆盖 (v3 反馈第 5 条, 强制本 PR):
 *   - row=full_access + 旧 options.permissionMode=default → agentMode=bypassPermissions (旧字段被忽略)
 *   - row=default + 旧 options.permissionMode=bypassPermissions (试图污染) → agentMode=default
 *   - row=full_access + options.permissionModeOverride=default → agentMode=default
 *   - row=full_access + options.permissionModeOverride=garbage → agentMode=bypassPermissions (走 row)
 *   - row=null + 旧 options.permissionMode=default → agentMode=default
 *   - 任何 ignoredDeprecated 字段被原样返回
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

describe('resolveChatStartAgentMode - 跨层回归 (v3 反馈第 5 条)', () => {
  it('核心 bug 修复: row=full_access + 旧 options.permissionMode=default (旧字段试图污染) → agentMode=bypassPermissions', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'full_access',
      optionOverride: undefined,
      deprecatedOption: 'default',
    });
    expect(r.agentMode).toBe('bypassPermissions');
    expect(r.fromRow).toBe('full_access');
    expect(r.override).toBeNull();
    expect(r.ignoredDeprecated).toBe('default');
  });

  it('row=default + 旧 options.permissionMode=bypassPermissions → agentMode=default (旧字段被忽略)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'default',
      optionOverride: undefined,
      deprecatedOption: 'bypassPermissions',
    });
    expect(r.agentMode).toBe('default');
    expect(r.ignoredDeprecated).toBe('bypassPermissions');
  });

  it('row=full_access + 旧 options.permissionMode=bypassPermissions (试图升级) → 旧字段被忽略', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'default',
      optionOverride: undefined,
      deprecatedOption: 'bypassPermissions',
    });
    expect(r.agentMode).toBe('default');
  });

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

  it('row=null + 旧 options.permissionMode=default → agentMode=default (DB 不可读降级, 不读旧字段)', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: null,
      optionOverride: undefined,
      deprecatedOption: 'default',
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

  it('同时存在 override 和 deprecated, override 生效, deprecated 仍记录', () => {
    const r = resolveChatStartAgentMode({
      rowProfile: 'full_access',
      optionOverride: 'auto',
      deprecatedOption: 'bypassPermissions',
    });
    expect(r.agentMode).toBe('auto');
    expect(r.override).toBe('auto');
    expect(r.ignoredDeprecated).toBe('bypassPermissions');
  });
});

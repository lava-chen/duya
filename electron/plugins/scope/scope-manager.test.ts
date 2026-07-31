import { describe, it, expect } from 'vitest';
import {
  resolveScopePriority,
  getScopeLabel,
  canUserModify,
  isAutoUpdateAllowed,
} from './scope-manager';
import { PluginScope, PLUGIN_SCOPE_PRIORITY } from '../types';

describe('resolveScopePriority', () => {
  it('sorts scopes by priority descending', () => {
    const sorted = resolveScopePriority([
      PluginScope.Local,
      PluginScope.User,
      PluginScope.Managed,
    ]);
    expect(sorted[0]).toBe(PluginScope.Managed);
    expect(sorted[1]).toBe(PluginScope.User);
    expect(sorted[2]).toBe(PluginScope.Local);
  });
});

describe('getScopeLabel', () => {
  it('returns correct labels', () => {
    expect(getScopeLabel(PluginScope.Managed)).toContain('Managed');
    expect(getScopeLabel(PluginScope.User)).toBe('User');
    expect(getScopeLabel(PluginScope.Builtin)).toContain('Built');
  });
});

describe('canUserModify', () => {
  it('returns false for Managed scope', () => {
    expect(canUserModify(PluginScope.Managed)).toBe(false);
  });

  it('returns true for other scopes', () => {
    expect(canUserModify(PluginScope.User)).toBe(true);
    expect(canUserModify(PluginScope.Builtin)).toBe(true);
    expect(canUserModify(PluginScope.Project)).toBe(true);
  });
});

describe('isAutoUpdateAllowed', () => {
  it('returns true when scope is in allowed list', () => {
    expect(isAutoUpdateAllowed(PluginScope.Builtin, [PluginScope.Builtin, PluginScope.Managed])).toBe(true);
  });

  it('returns false when scope is not in allowed list', () => {
    expect(isAutoUpdateAllowed(PluginScope.User, [PluginScope.Builtin, PluginScope.Managed])).toBe(false);
  });
});

describe('PLUGIN_SCOPE_PRIORITY', () => {
  it('Managed has highest priority', () => {
    const priorities = Object.values(PLUGIN_SCOPE_PRIORITY);
    expect(PLUGIN_SCOPE_PRIORITY[PluginScope.Managed]).toBe(Math.max(...priorities));
  });

  it('Local has lowest priority', () => {
    const priorities = Object.values(PLUGIN_SCOPE_PRIORITY);
    expect(PLUGIN_SCOPE_PRIORITY[PluginScope.Local]).toBe(Math.min(...priorities));
  });
});

/**
 * access.test.ts — Computer Use app allow/deny policy (plan 454 follow-up).
 *
 * Coverage:
 *   - deny-by-default: no allow-list + default deny → refused
 *   - allowed_apps substring match → allowed
 *   - glob patterns (* / ?) work
 *   - denied_apps overrides allowed_apps
 *   - case-insensitivity
 *   - no app info → refused (DENIED_BY_NO_APP)
 *   - default_access="allow" → allowed without pattern
 *   - focusedEntity fallback for macOS headless
 */

import { describe, it, expect } from 'vitest';

import {
  checkAccess,
  DEFAULT_POLICY,
  type AppAccessPolicy,
} from '../access.js';

const CHROME_CTX = {
  processName: 'chrome.exe',
  title: 'Inbox - Gmail',
  focusedEntity: null,
};

const VSCode_CTX = {
  processName: 'Code.exe',
  title: 'settings.json - duya',
  focusedEntity: null,
};

describe('checkAccess — default deny', () => {
  it('refuses when policy is null (no config at all)', () => {
    const v = checkAccess(null, CHROME_CTX);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_DEFAULT');
  });

  it('refuses when policy is empty + default deny', () => {
    const v = checkAccess({}, CHROME_CTX);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_DEFAULT');
  });

  it('refuses when allow-list empty + default deny', () => {
    const v = checkAccess(DEFAULT_POLICY, CHROME_CTX);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/allowed_apps/);
  });
});

describe('checkAccess — allowed_apps', () => {
  it('allows by exact processName substring', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['chrome'],
      denied_apps: [],
    };
    const v = checkAccess(policy, CHROME_CTX);
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('ALLOWED_BY_POLICY');
  });

  it('allows by window title substring', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['gmail'],
      denied_apps: [],
    };
    const v = checkAccess(policy, CHROME_CTX);
    expect(v.allowed).toBe(true);
  });

  it('allows via glob pattern', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['*code*'],
      denied_apps: [],
    };
    const v = checkAccess(policy, VSCode_CTX);
    expect(v.allowed).toBe(true);
  });

  it('matches single-char glob ?', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['code.???'],
      denied_apps: [],
    };
    const v = checkAccess(policy, { processName: 'code.exe', title: '', focusedEntity: null });
    expect(v.allowed).toBe(true);
  });

  it('is case-insensitive', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['CHROME'],
      denied_apps: [],
    };
    const v = checkAccess(policy, CHROME_CTX);
    expect(v.allowed).toBe(true);
  });
});

describe('checkAccess — denied_apps', () => {
  it('denied pattern overrides allowed pattern', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['chrome'],
      denied_apps: ['*bank*'],
    };
    const ctx = {
      processName: 'chrome.exe',
      title: 'Online Banking - Wells Fargo',
      focusedEntity: null,
    };
    const v = checkAccess(policy, ctx);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_PATTERN');
  });

  it('denied by default when only denied_apps present', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: [],
      denied_apps: ['chrome'],
    };
    const v = checkAccess(policy, CHROME_CTX);
    expect(v.allowed).toBe(false);
  });
});

describe('checkAccess — edge cases', () => {
  it('refuses when no app info available', () => {
    const v = checkAccess(DEFAULT_POLICY, { processName: null, title: null, focusedEntity: null });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_NO_APP');
  });

  it('default_access=allow permits any app', () => {
    const policy: AppAccessPolicy = {
      default_access: 'allow',
      allowed_apps: [],
      denied_apps: [],
    };
    const v = checkAccess(policy, CHROME_CTX);
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('ALLOWED_BY_DEFAULT');
  });

  it('focusedEntity name can be the match source (macOS headless)', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: ['calculator'],
      denied_apps: [],
    };
    const v = checkAccess(policy, {
      processName: null,
      title: null,
      focusedEntity: {
        kind: 'Button',
        name: 'Calculator',
        role: 'primary',
      } as never,
    });
    expect(v.allowed).toBe(true);
  });

  it('denied match on focusedEntity name works', () => {
    const policy: AppAccessPolicy = {
      default_access: 'deny',
      allowed_apps: [],
      denied_apps: ['settings'],
      denied: ['*'],
    } as never;
    // Just verify the denied path against focusedEntity name.
    const v = checkAccess(
      { default_access: 'deny', allowed_apps: [], denied_apps: ['settings'] },
      {
        processName: null,
        title: null,
        focusedEntity: { kind: 'Text', name: 'Settings.json', role: '' } as never,
      },
    );
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_PATTERN');
  });

  it('empty strings normalize away (no accidental match)', () => {
    const v = checkAccess(
      { default_access: 'deny', allowed_apps: ['chrome'], denied_apps: [] },
      { processName: '', title: '', focusedEntity: null },
    );
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('DENIED_BY_NO_APP');
  });
});

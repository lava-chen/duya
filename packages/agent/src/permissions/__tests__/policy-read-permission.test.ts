/**
 * policy-read-permission.test.ts - ReadTool permission policy tests.
 *
 * Behavior under test (`checkPathSafety` with write:false):
 *   - catastrophic paths (device nodes, System32) are always denied
 *   - in-workspace and skill-file reads are always allowed
 *   - out-of-workspace reads of NORMAL paths are allowed WITHOUT a prompt
 *     (read-only tools should not be gated like writes)
 *   - out-of-workspace reads of SENSITIVE paths (SSH/AWS keys, credential
 *     stores, cookie databases, duya's own secrets) still require explicit
 *     user confirmation
 *   - writes outside the workspace still require confirmation (unchanged)
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  checkPathSafety,
  isSensitiveReadPath,
  checkPathReadPermission,
  type PermissionCheckResult,
} from '../policy.js';
import type { ToolPermissionContext } from '../types.js';

function makeContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    defaultWorkspaceDirectory: 'C:/work/project',
    ...overrides,
  };
}

const WS = process.platform === 'win32' ? 'C:/work/project' : '/home/dev/project';
const HOME = homedir();

function read(filePath: string, wd = WS): PermissionCheckResult {
  return checkPathSafety(filePath, wd, makeContext(), { write: false });
}

describe('checkPathSafety read (write:false)', () => {
  it('allows in-workspace reads without confirmation', () => {
    const result = read(path.join(WS, 'src', 'a.ts'));
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBeFalsy();
  });

  it('allows out-of-workspace reads of normal paths without confirmation', () => {
    // Regression: previously every out-of-workspace read asked for approval,
    // making the Read tool feel as strict as Write. The memory dir is a
    // normal (non-sensitive) path and must be readable without a prompt.
    const memoryFile = path.join(HOME, '.duya', 'memory', 'items', 'note.md');
    const result = read(memoryFile);
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBeFalsy();
  });

  it('allows skill files without confirmation', () => {
    const result = read(path.join(HOME, '.duya', 'skills', 'research', 'SKILL.md'));
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBeFalsy();
  });

  it('requires confirmation for out-of-workspace sensitive reads', () => {
    const sensitive = [
      path.join(HOME, '.ssh', 'id_rsa'),
      path.join(HOME, '.ssh', 'config'),
      path.join(HOME, '.aws', 'credentials'),
      path.join(HOME, '.gnupg', 'secring.gpg'),
      path.join(HOME, '.duya', 'config.toml'),
      path.join(HOME, '.duya', 'secrets.json'),
      path.join(HOME, '.duya', 'mcp.toml'),
      path.join(HOME, '.git-credentials'),
      path.join(HOME, '.netrc'),
      path.join(HOME, '.password-store', 'entry.gpg'),
      'C:/Users/user/AppData/Local/Google/Chrome/User Data/Default/Cookies',
      'C:/Users/user/AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
      'C:/Users/user/AppData/Roaming/Mozilla/Firefox/Profiles/abc/cookies.sqlite',
      'C:/Users/user/AppData/Roaming/Microsoft/Credentials/abc',
    ];
    for (const filePath of sensitive) {
      const result = read(filePath);
      expect(result.allowed).toBe(true, `${filePath} must be allowed (read-only)`);
      expect(result.requiresUserConfirmation).toBe(true, `${filePath} must require confirmation`);
    }
  });

  it('denies catastrophic read paths regardless of mode', () => {
    const device = process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/dev/sda';
    const result = checkPathSafety(device, WS, makeContext({ mode: 'bypassPermissions' }), { write: false });
    expect(result.allowed).toBe(false);
  });
});

describe('checkPathSafety write (write:true) — unchanged regression', () => {
  it('still requires confirmation for out-of-workspace writes', () => {
    const result = checkPathSafety(
      path.join(HOME, '.duya', 'memory', 'new.md'),
      WS,
      makeContext(),
      { write: true },
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBe(true);
  });

  it('still allows in-workspace writes', () => {
    const result = checkPathSafety(path.join(WS, 'a.ts'), WS, makeContext(), { write: true });
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBeFalsy();
  });
});

describe('checkPathSafety — DUYA config write protection', () => {
  // Regression: a hand-edited config.toml (duplicate [hooks] table) made
  // the file unparseable, which silently wiped every provider on the next
  // settings write. The agent must never write these files directly.
  const configFiles = [
    path.join(HOME, '.duya', 'config.toml'),
    path.join(HOME, '.duya', 'secrets.json'),
    path.join(HOME, '.duya', 'mcp.toml'),
    path.join(HOME, '.duya', 'cronjob.toml'),
    path.join(HOME, '.duya', 'settings.json'),
  ];

  it.each(configFiles)('denies agent writes to %s', (filePath) => {
    const result = checkPathSafety(filePath, WS, makeContext(), { write: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('duya CLI');
  });

  it('denies config writes even in bypass mode (hard boundary)', () => {
    const result = checkPathSafety(
      path.join(HOME, '.duya', 'config.toml'),
      WS,
      makeContext({ mode: 'bypassPermissions' }),
      { write: true },
    );
    expect(result.allowed).toBe(false);
  });

  it('denies config writes even when the workspace IS ~/.duya', () => {
    const result = checkPathSafety(
      path.join(HOME, '.duya', 'config.toml'),
      path.join(HOME, '.duya'),
      makeContext(),
      { write: true },
    );
    expect(result.allowed).toBe(false);
  });

  it('allows writes to non-config files under ~/.duya (memory, skills, workspace)', () => {
    const ok = [
      path.join(HOME, '.duya', 'memory', 'items', 'note.md'),
      path.join(HOME, '.duya', 'skills', 'my-skill', 'SKILL.md'),
      path.join(HOME, '.duya', 'workspace', 'readme.md'),
    ];
    for (const filePath of ok) {
      const result = checkPathSafety(filePath, WS, makeContext(), { write: true });
      expect(result.allowed).toBe(true);
    }
  });

  it('still allows reading config.toml (with confirmation)', () => {
    const result = checkPathSafety(
      path.join(HOME, '.duya', 'config.toml'),
      WS,
      makeContext(),
      { write: false },
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBe(true);
  });
});

describe('isSensitiveReadPath', () => {
  it.each([
    [path.join(HOME, '.ssh', 'id_rsa'), true],
    [path.join(HOME, '.ssh', 'config'), true],
    [path.join(HOME, '.duya', 'config.toml'), true],
    [path.join(HOME, '.duya', 'secrets.json'), true],
    [path.join(HOME, '.duya', 'memory', 'items', 'note.md'), false],
    [path.join(HOME, '.duya', 'memory'), false],
    [path.join(HOME, '.duya', 'AGENTS.md'), false],
    [path.join(WS, 'src', 'index.ts'), false],
    ['C:/backup/cert.pem', true],
    ['C:/backup/monkey.md', false],
    ['/home/user/project/ssl.key', true],
  ])('%s → %s', (p, expected) => {
    expect(isSensitiveReadPath(p)).toBe(expected);
  });
});

describe('checkPathReadPermission (ReadTool entry)', () => {
  it('returns no confirmation for a normal out-of-workspace read', () => {
    const result = checkPathReadPermission(
      path.join(HOME, '.duya', 'memory', 'items', 'note.md'),
      WS,
      makeContext(),
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBeFalsy();
  });

  it('returns confirmation for a sensitive out-of-workspace read', () => {
    const result = checkPathReadPermission(path.join(HOME, '.ssh', 'id_rsa'), WS, makeContext());
    expect(result.allowed).toBe(true);
    expect(result.requiresUserConfirmation).toBe(true);
  });
});

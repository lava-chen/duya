/**
 * Tests for the unified SecurityPolicy layer.
 *
 * Verifies the two-tier safety model:
 *   - CATASTROPHIC: denied regardless of mode (even bypassPermissions)
 *   - SOFT: requires confirmation in normal mode, skipped in bypass mode
 *
 * Also covers the central `isCatastrophicToolCall` dispatcher that
 * `hasPermissionsToUseTool` calls BEFORE the bypass short-circuit, so
 * catastrophic ops are caught even when `checkPermissions` is skipped.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeCommandForDetection,
  isUNCPath,
  isCatastrophicPath,
  isCatastrophicCommand,
  checkPathSafety,
  checkCommandSafety,
  analyzeCommandSafety,
  isReadOnlyCommand,
  isCatastrophicToolCall,
} from '../../src/permissions/policy'
import type { ToolPermissionContext } from '../../src/permissions/types'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ctx(
  mode: ToolPermissionContext['mode'],
  overrides?: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

const BYPASS = ctx('bypassPermissions')
const DEFAULT = ctx('default')

// ----------------------------------------------------------------------------
// normalizeCommandForDetection
// ----------------------------------------------------------------------------

describe('normalizeCommandForDetection', () => {
  it('strips ANSI CSI escape sequences', () => {
    const obfuscated = '\x1b[31mrm\x1b[0m -rf /'
    expect(normalizeCommandForDetection(obfuscated)).toBe('rm -rf /')
  })

  it('strips OSC sequences', () => {
    const osc = '\x1b]0;title\x07rm -rf /'
    expect(normalizeCommandForDetection(osc)).toBe('rm -rf /')
  })

  it('strips null bytes', () => {
    expect(normalizeCommandForDetection('rm\x00 -rf /')).toBe('rm -rf /')
  })

  it('normalizes fullwidth Unicode to ASCII (NFKC)', () => {
    // Fullwidth 'r' (U+FF52) → ASCII 'r'
    const fullwidth = '\uFF52m -rf /'
    expect(normalizeCommandForDetection(fullwidth)).toBe('rm -rf /')
  })

  it('strips zero-width joiners and BOM', () => {
    expect(normalizeCommandForDetection('\u200Brm\u200B -rf /')).toBe('rm -rf /')
    expect(normalizeCommandForDetection('\uFEFFrm -rf /')).toBe('rm -rf /')
  })

  it('passes through safe commands unchanged', () => {
    expect(normalizeCommandForDetection('ls -la /tmp')).toBe('ls -la /tmp')
  })
})

// ----------------------------------------------------------------------------
// isUNCPath
// ----------------------------------------------------------------------------

describe('isUNCPath', () => {
  it('detects Windows UNC paths with backslashes', () => {
    expect(isUNCPath('\\\\server\\share')).toBe(true)
    expect(isUNCPath('\\\\server\\share\\file')).toBe(true)
  })

  it('detects UNC paths with forward slashes when host segment present', () => {
    expect(isUNCPath('//server/share')).toBe(true)
    expect(isUNCPath('//server/share/file')).toBe(true)
  })

  it('does NOT classify Unix absolute paths as UNC', () => {
    // Single-slash Unix paths must not trigger UNC detection — they
    // are legitimate local paths like /root/foo or /etc/passwd.
    expect(isUNCPath('/root/foo')).toBe(false)
    expect(isUNCPath('/etc/passwd')).toBe(false)
    expect(isUNCPath('/c/Users/foo')).toBe(false)
  })

  it('detects unc/ and smb: prefixes', () => {
    expect(isUNCPath('unc/server/share')).toBe(true)
    expect(isUNCPath('smb://server/share')).toBe(true)
  })

  it('rejects relative paths and plain filenames', () => {
    expect(isUNCPath('foo/bar')).toBe(false)
    expect(isUNCPath('file.txt')).toBe(false)
    expect(isUNCPath('./local')).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// isCatastrophicPath
// ----------------------------------------------------------------------------

describe('isCatastrophicPath', () => {
  it('flags Windows System32 as catastrophic', () => {
    expect(isCatastrophicPath('C:\\Windows\\System32\\evil.dll')).toBe(true)
    expect(isCatastrophicPath('C:\\Windows\\SysWOW64\\evil.dll')).toBe(true)
    expect(isCatastrophicPath('C:\\System32\\evil.dll')).toBe(true)
  })

  it('flags catastrophic Unix paths', () => {
    expect(isCatastrophicPath('/boot/vmlinuz')).toBe(true)
    expect(isCatastrophicPath('/dev/sda')).toBe(true)
    expect(isCatastrophicPath('/dev/nvme0n1')).toBe(true)
    expect(isCatastrophicPath('/dev/disk/by-id/xxx')).toBe(true)
  })

  it('flags UNC paths as catastrophic (credential leak vector)', () => {
    expect(isCatastrophicPath('\\\\attacker\\share\\payload')).toBe(true)
    expect(isCatastrophicPath('//attacker/share/payload')).toBe(true)
  })

  it('is case-insensitive on Windows paths', () => {
    expect(isCatastrophicPath('c:\\windows\\system32\\foo')).toBe(true)
    expect(isCatastrophicPath('C:\\WINDOWS\\SYSTEM32\\foo')).toBe(true)
  })

  it('does NOT flag soft-blocked paths as catastrophic', () => {
    // /etc, /var, C:\Windows (without System32) are SOFT, not catastrophic.
    expect(isCatastrophicPath('/etc/passwd')).toBe(false)
    expect(isCatastrophicPath('/var/log/foo')).toBe(false)
    expect(isCatastrophicPath('C:\\Windows\\foo.txt')).toBe(false)
    expect(isCatastrophicPath('/tmp/foo')).toBe(false)
  })

  it('resolves relative paths against working directory (Unix)', () => {
    // Unix-only: relative path that resolves into /dev/sda is caught.
    // On Windows, `resolve('/home/user', '../../../dev/sda')` produces
    // `E:\dev\sda` (with drive letter), which does NOT match the Unix
    // device prefix `/dev/sd`. Windows catastrophic paths are tested
    // separately below.
    if (process.platform === 'win32') return
    expect(isCatastrophicPath('../../../dev/sda', '/home/user')).toBe(true)
  })

  it('resolves relative paths against working directory (Windows)', () => {
    if (process.platform !== 'win32') return
    // A relative path that climbs up to C:\Windows\System32 is caught.
    expect(
      isCatastrophicPath('..\\..\\..\\Windows\\System32\\evil.dll', 'C:\\Users\\test\\project'),
    ).toBe(true)
  })

  it('allows safe workspace paths', () => {
    expect(isCatastrophicPath('/home/user/project/foo.ts', '/home/user/project')).toBe(false)
    expect(isCatastrophicPath('src/index.ts', '/home/user/project')).toBe(false)
  })

  it('excludes safe /dev paths (null, zero, random)', () => {
    // /dev/null and /dev/zero are safe — they fall through to the soft
    // /dev catch-all rather than being catastrophic.
    expect(isCatastrophicPath('/dev/null')).toBe(false)
    expect(isCatastrophicPath('/dev/zero')).toBe(false)
    expect(isCatastrophicPath('/dev/random')).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// isCatastrophicCommand
// ----------------------------------------------------------------------------

describe('isCatastrophicCommand', () => {
  it('flags recursive delete from root', () => {
    expect(isCatastrophicCommand('rm -rf /')).toBe(true)
    expect(isCatastrophicCommand('rm -rf /home')).toBe(true) // matches (home|etc|...) alt
    expect(isCatastrophicCommand('rm -rf /etc')).toBe(true)
    expect(isCatastrophicCommand('rm -rf /usr')).toBe(true)
  })

  it('flags mkfs (filesystem format)', () => {
    expect(isCatastrophicCommand('mkfs.ext4 /dev/sda1')).toBe(true)
    expect(isCatastrophicCommand('mkfs -t ext4 /dev/sda1')).toBe(true)
  })

  it('flags dd writes to block devices', () => {
    expect(isCatastrophicCommand('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(isCatastrophicCommand('dd if=img.iso of=/dev/mapper/vg-root')).toBe(true)
  })

  it('flags redirection to block devices', () => {
    expect(isCatastrophicCommand('cat payload > /dev/sda')).toBe(true)
  })

  it('flags fork bombs', () => {
    expect(isCatastrophicCommand(':(){ :|:& };:')).toBe(true)
  })

  it('flags kill -9 -1 (kill all processes)', () => {
    expect(isCatastrophicCommand('kill -9 -1')).toBe(true)
  })

  it('flags kill -9 1 (kill init)', () => {
    expect(isCatastrophicCommand('kill -9 1')).toBe(true)
  })

  it('does NOT flag soft-dangerous commands as catastrophic', () => {
    // These are SOFT (require confirmation in normal mode, bypassed in
    // bypass mode) but NOT catastrophic.
    expect(isCatastrophicCommand('rm -rf *')).toBe(false)
    expect(isCatastrophicCommand('git reset --hard')).toBe(false)
    expect(isCatastrophicCommand('git push --force')).toBe(false)
    expect(isCatastrophicCommand('chmod 777 /tmp')).toBe(false)
    expect(isCatastrophicCommand('sudo apt-get update')).toBe(false)
  })

  it('does NOT flag safe commands', () => {
    expect(isCatastrophicCommand('ls -la')).toBe(false)
    expect(isCatastrophicCommand('echo hello')).toBe(false)
    expect(isCatastrophicCommand('git status')).toBe(false)
  })

  it('catches obfuscated catastrophic commands (ANSI bypass attempt)', () => {
    // A user trying to bypass detection by embedding ANSI color codes
    // before `rm` should still be caught.
    expect(isCatastrophicCommand('\x1b[31mrm\x1b[0m -rf /')).toBe(true)
  })

  it('catches obfuscated catastrophic commands (null byte bypass)', () => {
    expect(isCatastrophicCommand('rm\x00 -rf /')).toBe(true)
  })

  it('catches fullwidth-Unicode obfuscated commands', () => {
    // Fullwidth 'r' (U+FF52) → ASCII 'r' via NFKC
    expect(isCatastrophicCommand('\uFF52m -rf /')).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// checkPathSafety (mode-aware full decision)
// ----------------------------------------------------------------------------

describe('checkPathSafety', () => {
  it('denies catastrophic paths even in bypass mode', () => {
    const result = checkPathSafety('C:\\Windows\\System32\\evil.dll', undefined, BYPASS, { write: true })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/catastrophic/i)
  })

  it('denies catastrophic paths in default mode', () => {
    const result = checkPathSafety('\\\\attacker\\share\\payload', undefined, DEFAULT, { write: true })
    expect(result.allowed).toBe(false)
  })

  it('allows any non-catastrophic path in bypass mode (skips soft checks)', () => {
    // /etc is soft-blocked, but bypass mode skips soft checks.
    const result = checkPathSafety('/etc/foo', undefined, BYPASS, { write: true })
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('requires confirmation for soft-blocked write paths in default mode', () => {
    const result = checkPathSafety('/etc/foo', undefined, DEFAULT, { write: true })
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBe(true)
  })

  it('does NOT require confirmation for soft-blocked READ paths', () => {
    // Reading /etc/passwd is fine — soft-blocked only applies to writes.
    const result = checkPathSafety('/etc/passwd', undefined, DEFAULT, { write: false })
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('allows paths inside the workspace without confirmation', () => {
    const result = checkPathSafety(
      '/home/user/project/src/index.ts',
      '/home/user/project',
      DEFAULT,
      { write: true },
    )
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('requires confirmation for paths outside the workspace in default mode', () => {
    const result = checkPathSafety(
      '/home/other/foo.txt',
      '/home/user/project',
      DEFAULT,
      { write: true },
    )
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBe(true)
  })

  it('allows paths outside the workspace in bypass mode', () => {
    const result = checkPathSafety(
      '/home/other/foo.txt',
      '/home/user/project',
      BYPASS,
      { write: true },
    )
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('allows paths in additional working directories', () => {
    const additional = new Map([['/home/user/other', { kind: 'local' as const }]])
    const result = checkPathSafety(
      '/home/user/other/foo.txt',
      '/home/user/project',
      ctx('default', { additionalWorkingDirectories: additional }),
      { write: true },
    )
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('allows writes to the skills directory even outside workspace', () => {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const skillsPath = `${home}/.duya/skills/my-skill/SKILL.md`.replace(/\\/g, '/')
    const result = checkPathSafety(skillsPath, '/home/user/project', DEFAULT, { write: true })
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('allows paths when no working directory is set (cannot check boundary)', () => {
    const result = checkPathSafety('/some/random/path', undefined, DEFAULT, { write: true })
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })
})

// ----------------------------------------------------------------------------
// checkCommandSafety (mode-aware full decision)
// ----------------------------------------------------------------------------

describe('checkCommandSafety', () => {
  it('denies catastrophic commands even in bypass mode', () => {
    const result = checkCommandSafety('rm -rf /', BYPASS)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/Recursive delete from root/i)
  })

  it('denies catastrophic commands in default mode', () => {
    const result = checkCommandSafety('mkfs.ext4 /dev/sda1', DEFAULT)
    expect(result.allowed).toBe(false)
  })

  it('allows soft-dangerous commands in bypass mode (skips soft checks)', () => {
    // git reset --hard is SOFT (high severity but not catastrophic).
    const result = checkCommandSafety('git reset --hard', BYPASS)
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('requires confirmation for soft-dangerous commands in default mode', () => {
    const result = checkCommandSafety('git reset --hard', DEFAULT)
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBe(true)
  })

  it('allows safe commands without confirmation in default mode', () => {
    const result = checkCommandSafety('ls -la', DEFAULT)
    expect(result.allowed).toBe(true)
    expect(result.requiresUserConfirmation).toBeFalsy()
  })

  it('includes a human-readable reason when denying', () => {
    const result = checkCommandSafety('rm -rf /', DEFAULT)
    expect(result.allowed).toBe(false)
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------------------------
// analyzeCommandSafety (display + auto-mode classification)
// ----------------------------------------------------------------------------

describe('analyzeCommandSafety', () => {
  it('returns safe=true for harmless commands', () => {
    const result = analyzeCommandSafety('ls -la')
    expect(result.safe).toBe(true)
    expect(result.warnings).toHaveLength(0)
    expect(result.requiresApproval).toBe(false)
  })

  it('flags git reset --hard as requiring approval', () => {
    const result = analyzeCommandSafety('git reset --hard')
    expect(result.requiresApproval).toBe(true)
    expect(result.warnings.some(w => /git reset --hard/.test(w.message))).toBe(true)
  })

  it('flags shell substitution syntax', () => {
    const result = analyzeCommandSafety('echo $(whoami)')
    expect(result.requiresApproval).toBe(true)
  })

  it('flags malformed syntax (unclosed quotes)', () => {
    const result = analyzeCommandSafety('echo "unclosed')
    expect(result.requiresApproval).toBe(true)
    expect(result.warnings.some(w => /malformed/i.test(w.message))).toBe(true)
  })

  it('flags redirections to system directories as critical', () => {
    const result = analyzeCommandSafety('echo foo > /etc/passwd')
    expect(result.requiresApproval).toBe(true)
    expect(result.warnings.some(w => w.severity === 'critical')).toBe(true)
  })

  it('flags complex commands (many pipes) as medium severity', () => {
    const result = analyzeCommandSafety('a | b | c | d | e')
    expect(result.warnings.some(w => w.severity === 'medium')).toBe(true)
  })

  it('detects catastrophic patterns in the warning list', () => {
    // analyzeCommandSafety is for DISPLAY, not gating — it reports
    // catastrophic patterns as critical warnings but `safe` reflects
    // whether ANY warning fired.
    const result = analyzeCommandSafety('rm -rf /')
    expect(result.warnings.some(w => w.severity === 'critical')).toBe(true)
    expect(result.requiresApproval).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// isReadOnlyCommand (auto-mode classifier)
// ----------------------------------------------------------------------------

describe('isReadOnlyCommand', () => {
  it('classifies common read-only commands', () => {
    expect(isReadOnlyCommand('ls -la')).toBe(true)
    expect(isReadOnlyCommand('pwd')).toBe(true)
    expect(isReadOnlyCommand('cat file.txt')).toBe(true)
    expect(isReadOnlyCommand('grep pattern file')).toBe(true)
    expect(isReadOnlyCommand('git status')).toBe(true)
    expect(isReadOnlyCommand('git log')).toBe(true)
    expect(isReadOnlyCommand('git diff')).toBe(true)
  })

  it('classifies git write subcommands as NOT read-only', () => {
    expect(isReadOnlyCommand('git commit -m foo')).toBe(false)
    expect(isReadOnlyCommand('git push')).toBe(false)
    expect(isReadOnlyCommand('git reset --hard')).toBe(false)
  })

  it('strips leading sudo before classification', () => {
    expect(isReadOnlyCommand('sudo ls -la')).toBe(true)
    expect(isReadOnlyCommand('sudo cat /etc/passwd')).toBe(true)
  })

  it('rejects rm even when it appears in the readonly-safe list', () => {
    // `rm` is in READONLY_SAFE_COMMANDS but the rm-detection guard
    // overrides it.
    expect(isReadOnlyCommand('rm -rf /tmp')).toBe(false)
  })

  it('classifies write commands as NOT read-only', () => {
    expect(isReadOnlyCommand('echo hello > file.txt')).toBe(false)
    expect(isReadOnlyCommand('mkdir newdir')).toBe(false)
    expect(isReadOnlyCommand('npm install')).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// isCatastrophicToolCall (central dispatcher)
// ----------------------------------------------------------------------------

describe('isCatastrophicToolCall', () => {
  it('flags catastrophic Bash commands', () => {
    expect(isCatastrophicToolCall('Bash', { command: 'rm -rf /' })).toBe(true)
    expect(isCatastrophicToolCall('bash', { command: 'mkfs.ext4 /dev/sda1' })).toBe(true)
  })

  it('flags catastrophic PowerShell commands', () => {
    expect(isCatastrophicToolCall('PowerShell', { command: 'rm -rf /' })).toBe(true)
    expect(isCatastrophicToolCall('powershell', { command: 'mkfs.ext4 /dev/sda1' })).toBe(true)
  })

  it('flags catastrophic Write paths', () => {
    expect(isCatastrophicToolCall('Write', { file_path: 'C:\\Windows\\System32\\evil.dll' })).toBe(true)
    expect(isCatastrophicToolCall('Write', { file_path: '/boot/vmlinuz' })).toBe(true)
    expect(isCatastrophicToolCall('Write', { file_path: '\\\\attacker\\share\\payload' })).toBe(true)
  })

  it('flags catastrophic Edit paths', () => {
    expect(isCatastrophicToolCall('Edit', { file_path: 'C:\\Windows\\SysWOW64\\evil.dll' })).toBe(true)
  })

  it('flags catastrophic Read paths (Read is a file tool — UNC reads leak credentials)', () => {
    // isCatastrophicToolCall includes 'read' in isFileTool, so
    // catastrophic path checks apply to Read too. This is intentional:
    //   - Read from \\attacker\share → credential leak (NTLM relay)
    //   - Read from C:\Windows\System32 → denied (conservative; reads
    //     are harmless but the central check does not distinguish
    //     read vs write for catastrophic paths)
    expect(isCatastrophicToolCall('Read', { file_path: 'C:\\Windows\\System32\\foo.dll' })).toBe(true)
    expect(isCatastrophicToolCall('Read', { file_path: '\\\\attacker\\share\\payload' })).toBe(true)
  })

  it('does NOT flag soft-dangerous Bash commands', () => {
    expect(isCatastrophicToolCall('Bash', { command: 'git reset --hard' })).toBe(false)
    expect(isCatastrophicToolCall('Bash', { command: 'rm -rf *' })).toBe(false)
    expect(isCatastrophicToolCall('Bash', { command: 'chmod 777 /tmp' })).toBe(false)
  })

  it('does NOT flag safe Bash commands', () => {
    expect(isCatastrophicToolCall('Bash', { command: 'ls -la' })).toBe(false)
    expect(isCatastrophicToolCall('Bash', { command: 'echo hello' })).toBe(false)
  })

  it('does NOT flag safe Write paths', () => {
    expect(isCatastrophicToolCall('Write', { file_path: '/home/user/project/foo.ts' })).toBe(false)
    expect(isCatastrophicToolCall('Write', { file_path: 'src/index.ts' })).toBe(false)
  })

  it('does NOT flag non-file, non-shell tools', () => {
    expect(isCatastrophicToolCall('AskUserQuestion', {})).toBe(false)
    expect(isCatastrophicToolCall('Glob', { pattern: '**/*.ts' })).toBe(false)
    expect(isCatastrophicToolCall('Grep', { pattern: 'foo' })).toBe(false)
  })

  it('resolves relative paths against working directory (Unix)', () => {
    if (process.platform === 'win32') return
    expect(
      isCatastrophicToolCall(
        'Write',
        { file_path: '../../../dev/sda' },
        '/home/user/project',
      ),
    ).toBe(true)
  })

  it('resolves relative paths against working directory (Windows)', () => {
    if (process.platform !== 'win32') return
    expect(
      isCatastrophicToolCall(
        'Write',
        { file_path: '..\\..\\..\\Windows\\System32\\evil.dll' },
        'C:\\Users\\test\\project',
      ),
    ).toBe(true)
  })

  it('returns false for missing file_path / command', () => {
    expect(isCatastrophicToolCall('Write', {})).toBe(false)
    expect(isCatastrophicToolCall('Bash', {})).toBe(false)
    expect(isCatastrophicToolCall('Write', { file_path: 123 })).toBe(false)
    expect(isCatastrophicToolCall('Bash', { command: 123 })).toBe(false)
  })

  it('ignores file_path on non-file tools', () => {
    // A Bash call with a stray file_path should not trigger path checks.
    expect(
      isCatastrophicToolCall('Bash', { command: 'ls', file_path: 'C:\\Windows\\System32\\evil.dll' }),
    ).toBe(false)
  })

  it('ignores command on non-shell tools', () => {
    // A Write call with a stray command should not trigger command checks.
    expect(
      isCatastrophicToolCall('Write', { file_path: 'safe.txt', command: 'rm -rf /' }),
    ).toBe(false)
  })
})

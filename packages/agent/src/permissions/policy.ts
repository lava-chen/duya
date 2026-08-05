/**
 * Authorization policy: mode, safety, and path/command gating.
 *
 * Merges the former safetyConstants, securityPolicy, pathPermission,
 * PermissionMode, and riskTierPermissions modules, plus the
 * workspace-boundary check that previously lived in permissions.ts.
 *
 * Two tiers of safety (see constants below):
 *   - CATASTROPHIC: denied regardless of mode. Even bypassPermissions
 *     cannot override these — they would brick the system.
 *   - SOFT: requires confirmation in normal mode, skipped in bypass
 *     mode.
 */

import * as path from 'node:path';
import { homedir } from 'node:os';
import type { PermissionCheckResult } from '../tool/types.js';
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
  type ToolPermissionContext,
} from './types.js';
import { expandPath } from '../utils/path.js';
import {
  tryParseShellCommand,
  hasMalformedTokens,
  hasDangerousShellSyntax,
} from '../utils/bash/shellQuote.js';
import {
  extractOutputRedirections,
  analyzeCommandComplexity,
} from '../utils/bash/commands.js';

// ============================================================================
// Shared Safety Types
// ============================================================================

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface SafetyPattern {
  pattern: RegExp;
  reason: string;
  severity: Severity;
}

export interface SecurityWarning {
  message: string;
  severity: Severity;
  pattern?: string;
}

export interface SecurityCheckResult {
  safe: boolean;
  warnings: SecurityWarning[];
  requiresApproval: boolean;
}

// ============================================================================
// Path Safety Constants
// ============================================================================

/**
 * Path prefixes that would brick the system if written to.
 *
 * Two matching styles:
 *   - DIRECTORY-style: matched as `prefix + '/'` OR exact `prefix`.
 *     Use for real directories (`/boot`) so `/bootloader` is NOT caught.
 *   - DEVICE-name-style: matched with plain `startsWith` (no `/` suffix).
 *     Use for `/dev/sd`, `/dev/nvme`, etc. so `/dev/sda`, `/dev/nvme0n1`
 *     are caught — these are device-name patterns, not directory paths.
 */
export const CATASTROPHIC_DIRECTORY_PREFIXES_UNIX: readonly string[] = [
  '/boot',
];

export const CATASTROPHIC_DEVICE_PREFIXES_UNIX: readonly string[] = [
  '/dev/sd', '/dev/disk', '/dev/loop', '/dev/nvme',
  '/dev/mapper', '/dev/vd', '/dev/xvd',
];

export const CATASTROPHIC_PATH_PREFIXES_WINDOWS: readonly string[] = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\System32',
  'C:\\SysWOW64',
];

/**
 * Path prefixes that are suspicious but not catastrophic.
 * Writing here requires confirmation in normal mode; bypassed in
 * bypass mode.
 */
export const SOFT_BLOCKED_PATH_PREFIXES_UNIX: readonly string[] = [
  '/etc', '/system', '/proc', '/sys',
  '/var', '/root', '/.ssh', '/.gnupg', '/.aws', '/run',
  '/private/etc', '/private/var', '/private/tmp', '/private/cores',
  '/dev',
];

export const SOFT_BLOCKED_PATH_PREFIXES_WINDOWS: readonly string[] = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Users\\All Users',
  'C:\\Users\\Default',
];

// ============================================================================
// Command Safety Constants
// ============================================================================

/**
 * Bash commands that cause catastrophic, unrecoverable system damage.
 * NEVER bypassed, even in bypassPermissions mode.
 */
export const CATASTROPHIC_BASH_PATTERNS: readonly SafetyPattern[] = [
  {
    pattern: /^\s*rm\s+(-[rfv]+\s+)*\//i,
    reason: 'Recursive delete from root directory',
    severity: 'critical',
  },
  {
    pattern: /^\s*rm\s+(-[rfv]+\s+)*(home|etc|usr|var|sys|proc)/i,
    reason: 'Recursive delete of system directory',
    severity: 'critical',
  },
  {
    pattern: /\bmkfs\b/i,
    reason: 'Format filesystem command',
    severity: 'critical',
  },
  {
    pattern: /\bdd\s+.*if=.*of=\/(dev|mapper)\b/i,
    reason: 'Direct block device write',
    severity: 'critical',
  },
  {
    pattern: />\s*\/dev\/sd\w/i,
    reason: 'Write to block device',
    severity: 'critical',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
    reason: 'Fork bomb',
    severity: 'critical',
  },
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;:\s*$/i,
    reason: 'Fork bomb',
    severity: 'critical',
  },
  {
    pattern: /kill\s+-9\s+-1\b/i,
    reason: 'Kill all processes (kill -9 -1)',
    severity: 'critical',
  },
  {
    pattern: /kill\s+-9\s+1\b/i,
    reason: 'Kill init process',
    severity: 'critical',
  },
];

/**
 * Bash patterns that are suspicious but not catastrophic.
 * Require confirmation in normal mode; bypassed in bypass mode.
 */
export const SOFT_BASH_PATTERNS: readonly SafetyPattern[] = [
  // ── Destructive: filesystem ─────────────────────────────────────────────
  {
    pattern: /rm\s+(-[rfv]+\s+)*\*/i,
    reason: 'Recursive delete of all files in current directory',
    severity: 'high',
  },
  {
    pattern: /\brmdir\b.*\$HOME/i,
    reason: 'Removing user home directory',
    severity: 'critical',
  },
  {
    pattern: /\bxargs\s+.*\brm\b/i,
    reason: 'xargs with rm (potential mass deletion)',
    severity: 'high',
  },
  {
    pattern: /\bfind\b.*-exec\s+(\/\S*\/)?rm\b/i,
    reason: 'find -exec rm',
    severity: 'high',
  },
  {
    pattern: /\bfind\b.*-delete\b/i,
    reason: 'find -delete (recursive delete)',
    severity: 'high',
  },
  {
    pattern: /tee\b.*["']?\/(etc|home|usr|var|sys)/i,
    reason: 'Overwrite system file via tee',
    severity: 'high',
  },
  {
    pattern: />>?\s*["']?\/(etc|home|usr|var|sys)/i,
    reason: 'Write to system directory via redirection',
    severity: 'high',
  },
  {
    pattern: />\s*\/etc\//i,
    reason: 'Overwrite system config in /etc/',
    severity: 'critical',
  },
  {
    pattern: /\b(cp|mv|install)\b.*\/etc\//i,
    reason: 'Copy/move file into /etc/',
    severity: 'high',
  },
  {
    pattern: /\bsed\s+-[^\s]*i.*\/etc\//i,
    reason: 'In-place edit of system config via sed',
    severity: 'high',
  },

  // ── Destructive: permissions ─────────────────────────────────────────────
  {
    pattern: /chmod\s+777/i,
    reason: 'World-writable permissions (chmod 777)',
    severity: 'medium',
  },
  {
    pattern: /chmod\s+-[^\s]*\s+777/i,
    reason: 'Setting chmod 777 permissions',
    severity: 'medium',
  },
  {
    pattern: /chmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)/i,
    reason: 'Recursive chmod with unsafe permissions',
    severity: 'high',
  },
  {
    pattern: /chown\s+(-[^\s]*)?R?\s+root/i,
    reason: 'Recursive chown to root',
    severity: 'high',
  },

  // ── Destructive: git ─────────────────────────────────────────────────────
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: 'git reset --hard destroys uncommitted changes',
    severity: 'high',
  },
  {
    pattern: /\bgit\s+push\b.*--force\b/i,
    reason: 'git force push rewrites remote history',
    severity: 'high',
  },
  {
    pattern: /\bgit\s+push\b.*-f\b/i,
    reason: 'git force push short flag',
    severity: 'high',
  },
  {
    pattern: /\bgit\s+clean\s+-[^\s]*f/i,
    reason: 'git clean with force deletes untracked files',
    severity: 'high',
  },
  {
    pattern: /\bgit\s+branch\s+-D\b/i,
    reason: 'git branch force delete',
    severity: 'medium',
  },

  // ── Shell injection ──────────────────────────────────────────────────────
  {
    pattern: /curl\s+.*\|\s*(ba)?sh\b/i,
    reason: 'Pipe curl download to shell',
    severity: 'high',
  },
  {
    pattern: /wget\s+.*\|\s*(ba)?sh\b/i,
    reason: 'Pipe wget download to shell',
    severity: 'high',
  },
  {
    pattern: /\b(bash|sh|zsh|ksh)\s+-[^\s]*c\b/i,
    reason: 'Shell command via -c flag',
    severity: 'high',
  },
  {
    pattern: /\b(python[23]?|perl|ruby|node)\s+-[ec]\s+/i,
    reason: 'Script execution via -e/-c flag',
    severity: 'high',
  },
  {
    pattern: /\b(python[23]?|perl|ruby|node)\s+<<\s*['"]?\w+['"]?/i,
    reason: 'Script execution via heredoc',
    severity: 'high',
  },
  {
    pattern: /eval\s+\$\(/i,
    reason: 'eval with command substitution',
    severity: 'critical',
  },
  {
    pattern: /`.*\$\(/i,
    reason: 'Backtick command substitution',
    severity: 'medium',
  },
  {
    pattern: /\$\([^)]*\$\(/i,
    reason: 'Nested command substitution',
    severity: 'high',
  },

  // ── Network: reverse shells ─────────────────────────────────────────────
  {
    pattern: /\bnc\s+-[elvp]/i,
    reason: 'Netcat with listen/execute/verbose port flag',
    severity: 'high',
  },
  {
    pattern: /\bncat\b/i,
    reason: 'ncat network tool',
    severity: 'medium',
  },
  {
    pattern: /\bsocat\b/i,
    reason: 'socat multipurpose relay',
    severity: 'high',
  },
  {
    pattern: /\/bin\/(ba)?sh\s+-i\s+.*>\/dev\/tcp\//i,
    reason: 'Bash reverse shell via /dev/tcp',
    severity: 'critical',
  },
  {
    pattern: /\bpython[23]?\s+-c\s+["']import\s+socket/i,
    reason: 'Python socket one-liner (reverse shell)',
    severity: 'critical',
  },
  {
    pattern: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i,
    reason: 'Tunneling service for external access',
    severity: 'high',
  },

  // ── SQL destructive ───────────────────────────────────────────────────────
  {
    pattern: /\bDROP\s+(TABLE|DATABASE)\b/i,
    reason: 'SQL DROP statement',
    severity: 'high',
  },
  {
    pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,
    reason: 'SQL DELETE without WHERE clause',
    severity: 'high',
  },
  {
    pattern: /\bTRUNCATE\s+TABLE/i,
    reason: 'SQL TRUNCATE table',
    severity: 'high',
  },

  // ── Process termination ──────────────────────────────────────────────────
  {
    pattern: /\bpkill\s+-9\b/i,
    reason: 'Force kill all matching processes',
    severity: 'critical',
  },
  {
    pattern: /\b(pkill|killall)\b.*\b(node|electron|duya)/i,
    reason: 'Kill self-process (agent termination)',
    severity: 'critical',
  },
  {
    pattern: /\bkill\b.*\$\(\s*pgrep\b/i,
    reason: 'Kill process via pgrep expansion',
    severity: 'high',
  },
  {
    pattern: /\bkill\b.*`\s*pgrep\b/i,
    reason: 'Kill process via backtick pgrep',
    severity: 'high',
  },
  {
    pattern: /killall\b/i,
    reason: 'Batch process termination',
    severity: 'medium',
  },

  // ── Privilege escalation ─────────────────────────────────────────────────
  {
    pattern: /passwd\b/i,
    reason: 'Modify user password',
    severity: 'medium',
  },
  {
    pattern: /su\s+root|\bsudo\s+/i,
    reason: 'Privilege escalation (su/sudo)',
    severity: 'medium',
  },
  {
    pattern: /\bvisudo\b/i,
    reason: 'Edit sudoers file',
    severity: 'critical',
  },

  // ── Gateway/systemd protection ───────────────────────────────────────────
  {
    pattern: /gateway\s+run\b.*(&\s*$|&amp;\s*;|&amp;$|\bdisown\b|\bsetsid\b)/i,
    reason: 'Start gateway outside systemd management',
    severity: 'high',
  },
  {
    pattern: /\bnohup\b.*gateway\s+run\b/i,
    reason: 'Start gateway with nohup outside systemd',
    severity: 'high',
  },

  // ── Credential theft patterns ───────────────────────────────────────────────
  {
    pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
    reason: 'Read secrets file',
    severity: 'critical',
  },
  {
    pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    reason: 'Curl with secret environment variable (exfiltration risk)',
    severity: 'critical',
  },
  {
    pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    reason: 'Wget with secret environment variable (exfiltration risk)',
    severity: 'critical',
  },
  {
    pattern: /printenv(?!\s+[^=]+=)|\s+env\s*\|/i,
    reason: 'Dump all environment variables',
    severity: 'high',
  },

  // ── System service manipulation ──────────────────────────────────────────
  {
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/i,
    reason: 'Stop/disable system service',
    severity: 'high',
  },
  {
    pattern: /\bservice\s+(iptables|firewalld|cron)\b.*(stop|disable|remove)/i,
    reason: 'Manipulate system services',
    severity: 'high',
  },

  // ── Other high risk ──────────────────────────────────────────────────────
  {
    pattern: /nmap/i,
    reason: 'Network scanning tool',
    severity: 'medium',
  },
  {
    pattern: /\bchmod\s+\+x\b.*[;&|]+\s*\.\//i,
    reason: 'chmod +x followed by immediate execution',
    severity: 'medium',
  },
];

// ============================================================================
// Command Normalization (bypass prevention)
// ============================================================================

/**
 * Normalize command before dangerous-pattern detection.
 *
 * Prevents bypass via ANSI escape sequences, null bytes, and Unicode
 * fullwidth/halfwidth obfuscation.
 */
export function normalizeCommandForDetection(command: string): string {
  command = command.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // CSI
  command = command.replace(/\x1b[>?][0-9]*[a-zA-Z]/g, ''); // DEC set
  command = command.replace(/\x1b[0-9]{2}[0-9;]*[a-zA-Z]/g, ''); // longer CSI
  command = command.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ''); // OSC
  command = command.replace(/\x9b|\x9c/g, ''); // CSI terminators
  command = command.replace(/\x90/g, ''); // DCS
  command = command.replace(/\x98|\x9d/g, ''); // OSC terminators
  command = command.replace(/\x00/g, '');
  command = command.normalize('NFKC');
  command = command.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '');
  return command;
}

// ============================================================================
// UNC Path Detection
// ============================================================================

/**
 * Check if path is a UNC path (Windows attack vector).
 */
export function isUNCPath(filePath: string): boolean {
  if (filePath.startsWith('\\\\')) return true;
  if (filePath.startsWith('//')) {
    const third = filePath.indexOf('/', 2);
    if (third > 2) return true;
    if (third === -1 && filePath.length > 2) return true;
  }
  if (/^unc[\\/]/i.test(filePath)) return true;
  if (/^smb:/i.test(filePath)) return true;
  return false;
}

// ============================================================================
// Path Safety
// ============================================================================

/**
 * Check if a resolved path matches any catastrophic prefix.
 * Mode-independent — catastrophic means NEVER allowed.
 */
export function isCatastrophicPath(filePath: string, workingDirectory?: string): boolean {
  const resolved = expandPath(filePath, workingDirectory);

  if (isUNCPath(resolved)) return true;

  const normalizedResolved = resolved.replace(/\\/g, '/');
  const normalizedLower = normalizedResolved.toLowerCase();

  for (const prefix of CATASTROPHIC_DIRECTORY_PREFIXES_UNIX) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedLower.startsWith(normalizedPrefix + '/') || normalizedLower === normalizedPrefix) {
      return true;
    }
  }

  for (const prefix of CATASTROPHIC_DEVICE_PREFIXES_UNIX) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedLower.startsWith(normalizedPrefix)) {
      return true;
    }
  }

  const winResolved = resolved.replace(/\//g, '\\').toLowerCase();
  for (const prefix of CATASTROPHIC_PATH_PREFIXES_WINDOWS) {
    const normalizedPrefix = prefix.toLowerCase();
    if (winResolved.startsWith(normalizedPrefix + '\\') || winResolved === normalizedPrefix) {
      return true;
    }
  }

  return false;
}

/**
 * Full path safety check (catastrophic + soft, mode-aware).
 */
export function checkPathSafety(
  filePath: string,
  workingDirectory: string | undefined,
  context: ToolPermissionContext | undefined,
  options?: { write?: boolean },
): PermissionCheckResult {
  const isWrite = options?.write ?? true;

  if (isCatastrophicPath(filePath, workingDirectory)) {
    return {
      allowed: false,
      reason: 'Writing to system-critical path is not allowed (catastrophic safety boundary)',
    };
  }

  if (context && isBypassMode(context.mode)) {
    return { allowed: true };
  }

  const resolvedPath = expandPath(filePath, workingDirectory);

  if (isWrite && isSoftBlockedPath(resolvedPath)) {
    return {
      allowed: true,
      requiresUserConfirmation: true,
      reason: 'Writing to system-sensitive directory requires confirmation',
    };
  }

  if (!workingDirectory) {
    return { allowed: true };
  }

  if (isPathInWorkspace(resolvedPath, workingDirectory, context)) {
    return { allowed: true };
  }

  if (isSkillFile(resolvedPath)) {
    return { allowed: true };
  }

  return {
    allowed: true,
    requiresUserConfirmation: true,
    reason: 'Path outside working directory',
  };
}

function isSoftBlockedPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replace(/\\/g, '/');
  const normalizedLower = normalized.toLowerCase();

  for (const prefix of SOFT_BLOCKED_PATH_PREFIXES_UNIX) {
    const lower = prefix.toLowerCase();
    if (normalizedLower.startsWith(lower + '/') || normalizedLower === lower) {
      return true;
    }
  }

  const winResolved = resolvedPath.replace(/\//g, '\\').toLowerCase();
  for (const prefix of SOFT_BLOCKED_PATH_PREFIXES_WINDOWS) {
    const lower = prefix.toLowerCase();
    if (winResolved.startsWith(lower + '\\') || winResolved === lower) {
      return true;
    }
  }

  return false;
}

function isPathInWorkspace(
  resolvedPath: string,
  workingDirectory: string,
  context: ToolPermissionContext | undefined,
): boolean {
  const resolvedWorkingDir = path.resolve(workingDirectory);
  const resolvedFilePath = path.resolve(resolvedPath);
  let normalizedWorkingDir = resolvedWorkingDir.replace(/\\/g, '/');
  let normalizedFilePath = resolvedFilePath.replace(/\\/g, '/');

  if (process.platform === 'win32') {
    normalizedWorkingDir = normalizedWorkingDir.toLowerCase();
    normalizedFilePath = normalizedFilePath.toLowerCase();
  }

  const workingDirPrefix = normalizedWorkingDir.endsWith('/')
    ? normalizedWorkingDir
    : normalizedWorkingDir + '/';

  if (normalizedFilePath.startsWith(workingDirPrefix) || normalizedFilePath === normalizedWorkingDir) {
    return true;
  }

  if (context?.additionalWorkingDirectories) {
    for (const [dirPath] of context.additionalWorkingDirectories) {
      const resolvedAdditionalDir = path.resolve(dirPath);
      let normalizedAdditionalDir = resolvedAdditionalDir.replace(/\\/g, '/');
      if (process.platform === 'win32') {
        normalizedAdditionalDir = normalizedAdditionalDir.toLowerCase();
      }
      const additionalDirPrefix = normalizedAdditionalDir.endsWith('/')
        ? normalizedAdditionalDir
        : normalizedAdditionalDir + '/';
      if (normalizedFilePath.startsWith(additionalDirPrefix) || normalizedFilePath === normalizedAdditionalDir) {
        return true;
      }
    }
  }

  return false;
}

function isSkillFile(resolvedPath: string): boolean {
  const homeDir = homedir();
  const normalizedHomeDir = (process.platform === 'win32' ? homeDir.toLowerCase() : homeDir).replace(/\\/g, '/');
  const skillsDirPrefix = normalizedHomeDir + '/.duya/skills/';
  const normalizedFilePath = (process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath).replace(/\\/g, '/');
  return normalizedFilePath.startsWith(skillsDirPrefix) || normalizedFilePath === skillsDirPrefix.slice(0, -1);
}

// ============================================================================
// Command Safety
// ============================================================================

/**
 * Check if a command matches any catastrophic pattern.
 * Mode-independent — catastrophic means NEVER allowed.
 */
export function isCatastrophicCommand(command: string): boolean {
  const normalized = normalizeCommandForDetection(command);
  return CATASTROPHIC_BASH_PATTERNS.some(p => p.pattern.test(normalized));
}

/**
 * Full command safety check (catastrophic + soft, mode-aware).
 */
export function checkCommandSafety(
  command: string,
  context: ToolPermissionContext | undefined,
): PermissionCheckResult {
  if (isCatastrophicCommand(command)) {
    const normalized = normalizeCommandForDetection(command);
    const match = CATASTROPHIC_BASH_PATTERNS.find(p => p.pattern.test(normalized));
    return {
      allowed: false,
      reason: match?.reason ?? 'Command is catastrophically dangerous and cannot be executed',
    };
  }

  if (context && isBypassMode(context.mode)) {
    return { allowed: true };
  }

  const analysis = analyzeCommandSafety(command);
  if (!analysis.safe || analysis.requiresApproval) {
    return {
      allowed: true,
      requiresUserConfirmation: true,
      reason: analysis.warnings.map(w => w.message).join('; '),
    };
  }

  return { allowed: true };
}

/**
 * Analyze a command for safety warnings. Used for auto-mode
 * classification and informational warning display (NOT for gating).
 */
export function analyzeCommandSafety(command: string): SecurityCheckResult {
  const normalized = normalizeCommandForDetection(command);

  const warnings: SecurityWarning[] = [];
  let requiresApproval = false;

  const parseResult = tryParseShellCommand(normalized);

  if (parseResult.success && hasMalformedTokens(parseResult.tokens)) {
    warnings.push({
      message: 'Command has malformed syntax (unclosed quotes)',
      severity: 'high',
    });
    requiresApproval = true;
  }

  if (hasDangerousShellSyntax(normalized)) {
    warnings.push({
      message: 'Command contains shell substitution syntax ($() or ` `) which may execute arbitrary code',
      severity: 'high',
    });
    requiresApproval = true;
  }

  const redirectionInfo = extractOutputRedirections(normalized);
  if (redirectionInfo.hasDangerousRedirection) {
    warnings.push({
      message: `Output redirection to potentially dangerous target: ${redirectionInfo.redirections.map(r => r.target).join(', ')}`,
      severity: 'high',
    });
    requiresApproval = true;
  }

  for (const redir of redirectionInfo.redirections) {
    if (/^\/(etc|sys|proc|dev|usr|bin|sbin|lib|var)\//.test(redir.target)) {
      warnings.push({
        message: `Writing to system directory: ${redir.target}`,
        severity: 'critical',
      });
      requiresApproval = true;
    }
  }

  const complexity = analyzeCommandComplexity(normalized);
  if (complexity.complexity === 'complex') {
    warnings.push({
      message: `Complex command detected (${complexity.pipeCount} pipes, ${complexity.chainCount} chains, subshell: ${complexity.hasSubshell}) - review carefully`,
      severity: 'medium',
    });
  }

  for (const { pattern, reason, severity } of CATASTROPHIC_BASH_PATTERNS) {
    if (pattern.test(normalized)) {
      warnings.push({ message: reason, severity, pattern: pattern.source });
      if (severity === 'critical' || severity === 'high') {
        requiresApproval = true;
      }
    }
  }

  for (const { pattern, reason, severity } of SOFT_BASH_PATTERNS) {
    if (pattern.test(normalized)) {
      warnings.push({ message: reason, severity, pattern: pattern.source });
      if (severity === 'critical' || severity === 'high') {
        requiresApproval = true;
      }
    }
  }

  if (/\$\(|`/.test(normalized)) {
    if (/\$\{?\w+\}?/.test(normalized)) {
      warnings.push({
        message: 'Command contains variable substitution - potential injection risk',
        severity: 'medium',
      });
    }
  }

  const pipeCount = (normalized.match(/\|/g) || []).length;
  if (pipeCount > 3) {
    warnings.push({
      message: `Command contains ${pipeCount} pipe operations - consider simplifying`,
      severity: 'low',
    });
  }

  const operatorCount = (normalized.match(/&&|\|\|/g) || []).length;
  if (operatorCount > 5) {
    warnings.push({
      message: `Command contains ${operatorCount} logical operators - consider splitting`,
      severity: 'low',
    });
  }

  if (/\s+&$/.test(normalized)) {
    warnings.push({ message: 'Command will run in background', severity: 'low' });
  }

  if (/>\s*[|&]/.test(normalized)) {
    warnings.push({ message: 'Command contains abnormal redirect syntax', severity: 'medium' });
  }

  return {
    safe: warnings.length === 0,
    warnings,
    requiresApproval,
  };
}

// ============================================================================
// Read-only Command Detection (for auto-mode classification)
// ============================================================================

const READONLY_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'type', 'file',
  'stat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'node', 'python', 'python3', 'ruby', 'perl', 'php',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'df', 'du', 'free', 'top', 'ps', 'env', 'id', 'whoami',
  'hostname', 'uname', 'uptime', 'date', 'cal', 'lsblk', 'mount', 'umount',
]);

const READONLY_SUBCOMMAND_TOOLS = new Set([
  'git', 'svn', 'hg', 'npm', 'yarn', 'pnpm',
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'fetch', 'ls-files', 'ls-tree',
]);
const READONLY_NPM_SUBCOMMANDS = new Set([
  'ls', 'pack', 'view', 'info', 'search',
]);

/**
 * Check if command is read-only. Used by auto-mode classifier.
 * Conservative: when in doubt, return false so the auto-mode
 * classifier falls back to the LLM.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (/>>?/.test(trimmed)) {
    return false;
  }

  const parseResult = tryParseShellCommand(trimmed);

  const tokens = parseResult.success ? parseResult.tokens : trimmed.split(/\s+/);
  let cmdIndex = 0;
  if (tokens.length > 1 && tokens[0].toLowerCase() === 'sudo') {
    cmdIndex = 1;
  }
  const firstCmd = (tokens[cmdIndex] ?? '').replace(/^.*[/\\]/, '').toLowerCase();

  if (!firstCmd) return false;

  if (READONLY_SUBCOMMAND_TOOLS.has(firstCmd)) {
    const subCmd = tokens[cmdIndex + 1]?.toLowerCase();
    if (firstCmd === 'git' && subCmd && READONLY_GIT_SUBCOMMANDS.has(subCmd)) {
      return true;
    }
    if (firstCmd === 'npm' && subCmd && READONLY_NPM_SUBCOMMANDS.has(subCmd)) {
      return true;
    }
    return false;
  }

  if (READONLY_SAFE_COMMANDS.has(firstCmd)) {
    if (firstCmd === 'rm' || /\brm\s/.test(trimmed)) {
      return false;
    }
    return true;
  }

  return false;
}

// ============================================================================
// Central Flow: Tool Safety Dispatch
// ============================================================================

/**
 * Check if a tool call is catastrophically dangerous.
 * Called by the central `hasPermissionsToUseTool` BEFORE the bypass
 * short-circuit, so catastrophic ops are caught even when
 * `checkPermissions` is skipped (bypass mode).
 */
export function isCatastrophicToolCall(
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory?: string,
): boolean {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (filePath && isFileTool(toolName)) {
    return isCatastrophicPath(filePath, workingDirectory);
  }

  const command = typeof input.command === 'string' ? input.command : undefined;
  if (command && isShellTool(toolName)) {
    return isCatastrophicCommand(command);
  }

  return false;
}

function isFileTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === 'write' || lower === 'edit' || lower === 'read';
}

function isShellTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === 'bash' || lower === 'powershell' || lower === 'shell';
}

// ============================================================================
// Workspace-boundary check (formerly in permissions.ts)
// ============================================================================

/**
 * Check if a tool's operation is confined within the workspace directory.
 * Tools operating within the workspace get automatic allow.
 */
export function isToolWithinWorkspace(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
): boolean {
  const fileSystemTools = ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep']
  if (!fileSystemTools.includes(toolName)) {
    return false
  }

  const paths: string[] = []

  if (typeof input.path === 'string') {
    paths.push(input.path)
  }
  if (typeof input.command === 'string') {
    const cdMatch = input.command.match(/cd\s+["']?([^"';\s]+)/)
    if (cdMatch) {
      paths.push(cdMatch[1])
    }
  }
  if (typeof input.cwd === 'string') {
    paths.push(input.cwd)
  }
  if (typeof input.file_path === 'string') {
    paths.push(input.file_path)
  }
  if (typeof input.directory === 'string') {
    paths.push(input.directory)
  }
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) {
      if (typeof p === 'string') paths.push(p)
    }
  }

  if (paths.length === 0) {
    return false
  }

  const allowedDirs: string[] = []

  for (const [dirPath] of context.additionalWorkingDirectories) {
    allowedDirs.push(path.resolve(dirPath))
  }

  if (context.defaultWorkspaceDirectory) {
    allowedDirs.push(path.resolve(context.defaultWorkspaceDirectory))
    allowedDirs.push(path.resolve(path.join(context.defaultWorkspaceDirectory, '..')))
  } else {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    if (homeDir) {
      allowedDirs.push(path.resolve(path.join(homeDir, '.duya', 'workspace')))
      allowedDirs.push(path.resolve(path.join(homeDir, '.duya')))
    }
  }

  for (const p of paths) {
    const resolved = path.resolve(p)
    const isWithin = allowedDirs.some((allowed) => {
      const rel = path.relative(allowed, resolved)
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    if (!isWithin) {
      return false
    }
  }

  return true
}

// ============================================================================
// Risk-tier gating for connector tools (Plan 312 Phase 4)
// ============================================================================

/**
 * Five-tier risk classification (mirrors `RiskTier` from the electron
 * side; duplicated here so the agent package has no electron import).
 */
export type RiskTier = 'read' | 'draft' | 'write' | 'modify' | 'destructive';

export const RISK_TIER_ORDER: readonly RiskTier[] = [
  'read',
  'draft',
  'write',
  'modify',
  'destructive',
] as const;

/**
 * Normalize an unknown tier value. If the value is not a known tier,
 * return `undefined` so the caller can apply the conservative default.
 */
export function normalizeRiskTier(value: unknown): RiskTier | undefined {
  if (typeof value !== 'string') return undefined;
  return (RISK_TIER_ORDER as readonly string[]).includes(value)
    ? (value as RiskTier)
    : undefined;
}

/**
 * Conservative default when a descriptor omits the tier. `write` is the
 * lowest tier that requires confirmation.
 */
export const DEFAULT_MISSING_TIER: RiskTier = 'write';

/**
 * Decide the permission behavior for a connector tool given its
 * declared risk tier and the current permission mode.
 *
 * Returns:
 *   - `'allow'`          — tier permits auto-execution
 *   - `'ask'`            — user must confirm before execute
 *   - `'strong-confirm'` — destructive; NEVER bypassed
 *   - `undefined`        — no tier-based opinion; fall through to the
 *                          regular permission flow
 */
export function riskTierToBehavior(
  tier: RiskTier | undefined,
  mode: PermissionMode,
): 'allow' | 'ask' | 'strong-confirm' | undefined {
  const effectiveTier = tier ?? DEFAULT_MISSING_TIER;
  const isBypassMode = mode === 'bypassPermissions' || mode === 'dontAsk';

  switch (effectiveTier) {
    case 'read':
    case 'draft':
      return undefined;
    case 'write':
    case 'modify':
      if (isBypassMode) return undefined;
      return 'ask';
    case 'destructive':
      return 'strong-confirm';
    default:
      return undefined;
  }
}

// ============================================================================
// Permission Mode configuration
// ============================================================================

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

export const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: '',
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '',
    color: 'error',
    external: 'dontAsk',
  },
  auto: {
    title: 'Auto mode',
    shortTitle: 'Auto',
    symbol: '',
    color: 'warning',
    external: 'default',
  },
}

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

/**
 * Type guard to check if a PermissionMode is an ExternalPermissionMode.
 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return mode !== 'auto' && mode !== 'bubble'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}

/**
 * Check if the current permission mode is bypassPermissions or plan mode
 * with bypass available. In these modes, tools should skip their internal
 * safety checks (like working directory restrictions).
 */
export function isBypassMode(mode: string | PermissionMode | undefined): boolean {
  return mode === 'bypassPermissions' || mode === 'dontAsk'
}

// ============================================================================
// Path permission wrappers (thin wrappers around checkPathSafety)
// ============================================================================

export function checkPathReadPermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  // Reads only check catastrophic paths (e.g. /dev/sda would hang or
  // return garbage). Soft blocked paths like /etc are fine to read.
  return checkPathSafety(filePath, workingDirectory, toolPermissionContext, { write: false });
}

export function checkPathWritePermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  return checkPathSafety(filePath, workingDirectory, toolPermissionContext, { write: true });
}
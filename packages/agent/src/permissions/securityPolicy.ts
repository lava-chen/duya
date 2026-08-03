/**
 * Unified SecurityPolicy layer.
 *
 * Single source of truth for safety decisions that depend on the
 * permission mode. Replaces the scattered hardcoded checks that
 * previously lived inside each tool's `execute()` method.
 *
 * Two tiers (see safetyConstants.ts):
 *   - CATASTROPHIC: denied regardless of mode. Even bypassPermissions
 *     cannot override these — they would brick the system.
 *   - SOFT: requires confirmation in normal mode, skipped in bypass
 *     mode.
 *
 * Call sites:
 *   1. Central `hasPermissionsToUseTool` calls `checkToolSafetyCatastrophic`
 *      BEFORE the bypass short-circuit so catastrophic ops are caught
 *      even when checkPermissions is skipped (bypass mode).
 *   2. Tool `checkPermissions` calls `checkPathSafety` / `checkCommandSafety`
 *      for the full mode-aware decision (catastrophic + soft).
 *   3. Tool `execute` trusts the earlier decision — NO safety checks here.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { PermissionCheckResult } from '../tool/types.js';
import { isBypassMode } from './PermissionMode.js';
import type { PermissionMode, ToolPermissionContext } from './types.js';
import { expandPath } from '../utils/path.js';
import {
  CATASTROPHIC_DIRECTORY_PREFIXES_UNIX,
  CATASTROPHIC_DEVICE_PREFIXES_UNIX,
  CATASTROPHIC_PATH_PREFIXES_WINDOWS,
  SOFT_BLOCKED_PATH_PREFIXES_UNIX,
  SOFT_BLOCKED_PATH_PREFIXES_WINDOWS,
  CATASTROPHIC_BASH_PATTERNS,
  SOFT_BASH_PATTERNS,
  type SecurityCheckResult,
  type SecurityWarning,
  type Severity,
} from './safetyConstants.js';
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
// Command Normalization (bypass prevention)
// ============================================================================

/**
 * Normalize command before dangerous-pattern detection.
 *
 * Prevents bypass via:
 * - ANSI escape sequences (color codes, cursor movement)
 * - Null bytes
 * - Unicode fullwidth/halfwidth obfuscation
 */
export function normalizeCommandForDetection(command: string): string {
  // Strip ANSI escape sequences (CSI, OSC, DCS, 8-bit C1)
  command = command.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // CSI
  command = command.replace(/\x1b[>?][0-9]*[a-zA-Z]/g, ''); // DEC set
  command = command.replace(/\x1b[0-9]{2}[0-9;]*[a-zA-Z]/g, ''); // longer CSI
  command = command.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ''); // OSC
  command = command.replace(/\x9b|\x9c/g, ''); // CSI terminators
  command = command.replace(/\x90/g, ''); // DCS
  command = command.replace(/\x98|\x9d/g, ''); // OSC terminators

  // Strip null bytes
  command = command.replace(/\x00/g, '');

  // Normalize Unicode (NFKC) to prevent fullwidth char obfuscation
  command = command.normalize('NFKC');

  // Remove zero-width joiners and spaces that could hide patterns
  command = command.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '');

  return command;
}

// ============================================================================
// UNC Path Detection
// ============================================================================

/**
 * Check if path is a UNC path (Windows attack vector).
 * UNC paths start with \\\\server\\share or //server/share.
 * Regular Unix absolute paths like /root/... or /c/... are NOT UNC paths.
 *
 * Detection rules:
 *   - \\server\share  → match (single backslash pair at start)
 *   - //server/share → match ONLY when the second segment is non-empty
 *     AND looks like a hostname (no slash until later). Unix paths
 *     like /root/foo have a single slash, never a //server/... form.
 *   - unc\foo or unc/foo → match
 *   - smb://... → match
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
 *
 * Two matching styles (see safetyConstants.ts):
 *   - Directory prefixes: `prefix + '/'` OR exact `prefix`.
 *     Prevents false positives like `/bootloader` matching `/boot`.
 *   - Device-name prefixes: plain `startsWith` (no `/` suffix).
 *     Catches `/dev/sda`, `/dev/nvme0n1`, etc.
 */
export function isCatastrophicPath(filePath: string, workingDirectory?: string): boolean {
  const resolved = expandPath(filePath, workingDirectory);

  // UNC paths are catastrophic (credential leak vector)
  if (isUNCPath(resolved)) return true;

  const normalizedResolved = resolved.replace(/\\/g, '/');
  const normalizedLower = normalizedResolved.toLowerCase();

  // Directory-style: need `/` separator or exact match
  for (const prefix of CATASTROPHIC_DIRECTORY_PREFIXES_UNIX) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedLower.startsWith(normalizedPrefix + '/') || normalizedLower === normalizedPrefix) {
      return true;
    }
  }

  // Device-name-style: plain startsWith (e.g. /dev/sd matches /dev/sda)
  for (const prefix of CATASTROPHIC_DEVICE_PREFIXES_UNIX) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedLower.startsWith(normalizedPrefix)) {
      return true;
    }
  }

  // Windows catastrophic paths (case-insensitive, backslash separator)
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
 *
 * Used by tool `checkPermissions` to make the complete decision:
 *   - catastrophic path → { allowed: false } (NEVER bypassed)
 *   - soft blocked path, non-bypass mode → { allowed: true, requiresUserConfirmation: true }
 *   - soft blocked path, bypass mode → { allowed: true }
 *   - path outside workspace, non-bypass mode → { allowed: true, requiresUserConfirmation: true }
 *   - path in workspace → { allowed: true }
 */
export function checkPathSafety(
  filePath: string,
  workingDirectory: string | undefined,
  context: ToolPermissionContext | undefined,
  options?: { write?: boolean },
): PermissionCheckResult {
  const isWrite = options?.write ?? true;

  // 1. Catastrophic — NEVER bypassed, even in bypassPermissions mode
  if (isCatastrophicPath(filePath, workingDirectory)) {
    return {
      allowed: false,
      reason: 'Writing to system-critical path is not allowed (catastrophic safety boundary)',
    };
  }

  // 2. Bypass mode: skip all soft checks
  if (context && isBypassMode(context.mode)) {
    return { allowed: true };
  }

  const resolvedPath = expandPath(filePath, workingDirectory);

  // 3. Soft blocked paths (write only — reads of /etc/passwd etc. are fine).
  //    Checked BEFORE the working-directory early-return because soft-blocked
  //    paths are absolute system paths — their evaluation does not depend on
  //    a working directory.
  if (isWrite && isSoftBlockedPath(resolvedPath)) {
    return {
      allowed: true,
      requiresUserConfirmation: true,
      reason: 'Writing to system-sensitive directory requires confirmation',
    };
  }

  // 4. No working directory: allow (can't check workspace boundary)
  if (!workingDirectory) {
    return { allowed: true };
  }

  // 5. Workspace boundary check
  if (isPathInWorkspace(resolvedPath, workingDirectory, context)) {
    return { allowed: true };
  }

  // 6. Skills directory is always allowed
  if (isSkillFile(resolvedPath)) {
    return { allowed: true };
  }

  // 7. Outside workspace — requires confirmation in normal mode
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
  // Resolve BOTH paths the same way so they get consistent drive-letter
  // treatment on Windows. `expandPath` uses `normalize` for absolute paths
  // (which does NOT add a drive letter on Windows), while `resolve` does.
  // If we only `resolve` the working directory, the comparison fails on
  // Windows for absolute Unix-style paths like /home/user/project/...
  const resolvedWorkingDir = resolve(workingDirectory);
  const resolvedFilePath = resolve(resolvedPath);
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

  // Additional working directories
  if (context?.additionalWorkingDirectories) {
    for (const [dirPath] of context.additionalWorkingDirectories) {
      const resolvedAdditionalDir = resolve(dirPath);
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
 *
 * Used by tool `checkPermissions` to make the complete decision:
 *   - catastrophic command → { allowed: false } (NEVER bypassed)
 *   - soft dangerous command, non-bypass mode → { allowed: true, requiresUserConfirmation: true }
 *   - soft dangerous command, bypass mode → { allowed: true }
 *   - safe command → { allowed: true }
 */
export function checkCommandSafety(
  command: string,
  context: ToolPermissionContext | undefined,
): PermissionCheckResult {
  // 1. Catastrophic — NEVER bypassed
  if (isCatastrophicCommand(command)) {
    const normalized = normalizeCommandForDetection(command);
    const match = CATASTROPHIC_BASH_PATTERNS.find(p => p.pattern.test(normalized));
    return {
      allowed: false,
      reason: match?.reason ?? 'Command is catastrophically dangerous and cannot be executed',
    };
  }

  // 2. Bypass mode: skip all soft checks
  if (context && isBypassMode(context.mode)) {
    return { allowed: true };
  }

  // 3. Soft patterns — require confirmation in normal mode
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

// ============================================================================
// Command Warning Analysis (display + auto-mode classification)
// ============================================================================

/**
 * Analyze a command for safety warnings. Used for:
 *   - Auto-mode classification (isLocallySafeAutoModeAction)
 *   - Informational warning display in tool output (NOT for gating)
 *
 * This is the renamed `checkSecurity` from BashTool, refactored to use
 * the centralized pattern constants from safetyConstants.ts.
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

  // Check both catastrophic and soft patterns for warning display
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

/**
 * Commands that are ALWAYS read-only regardless of arguments.
 * NEVER include tools with subcommands that can write (git, npm, etc.)
 * — those belong in READONLY_SUBCOMMAND_TOOLS which checks the subcommand.
 */
const READONLY_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'type', 'file',
  'stat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'node', 'python', 'python3', 'ruby', 'perl', 'php',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'df', 'du', 'free', 'top', 'ps', 'env', 'id', 'whoami',
  'hostname', 'uname', 'uptime', 'date', 'cal', 'lsblk', 'mount', 'umount',
]);

/**
 * Tools that are read-only ONLY for specific subcommands.
 * The subcommand (second word) is checked against a whitelist.
 * `git commit`, `git push`, `npm install` etc. are NOT read-only.
 */
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
 *
 * A command is read-only when it neither mutates state nor produces
 * side effects. This function is conservative: when in doubt, return
 * false so the auto-mode classifier falls back to the LLM.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Output redirection (`>`, `>>`) turns any command into a write.
  // Even `echo` becomes a write when redirected to a file.
  if (/>>?/.test(trimmed)) {
    return false;
  }

  const parseResult = tryParseShellCommand(trimmed);

  // Determine the first command word, skipping a leading `sudo`.
  // `getCommandFromTokens` returns only the first token, so a separate
  // sudo-skip step is needed to reach the real command word.
  const tokens = parseResult.success ? parseResult.tokens : trimmed.split(/\s+/);
  let cmdIndex = 0;
  if (tokens.length > 1 && tokens[0].toLowerCase() === 'sudo') {
    cmdIndex = 1;
  }
  const firstCmd = (tokens[cmdIndex] ?? '').replace(/^.*[/\\]/, '').toLowerCase();

  if (!firstCmd) return false;

  // Tools with subcommand-based read-only classification.
  // Checked BEFORE READONLY_SAFE_COMMANDS so that `git commit` is NOT
  // classified as read-only even though `git` was previously in both sets.
  if (READONLY_SUBCOMMAND_TOOLS.has(firstCmd)) {
    const subCmd = tokens[cmdIndex + 1]?.toLowerCase();
    if (firstCmd === 'git' && subCmd && READONLY_GIT_SUBCOMMANDS.has(subCmd)) {
      return true;
    }
    if (firstCmd === 'npm' && subCmd && READONLY_NPM_SUBCOMMANDS.has(subCmd)) {
      return true;
    }
    // svn/hg/yarn/pnpm: no safe subcommand whitelist yet → conservative false.
    return false;
  }

  // Always-read-only commands (ls, cat, pwd, ...). Still gated by the
  // redirection check above so `cat foo > /etc/passwd` is a write.
  if (READONLY_SAFE_COMMANDS.has(firstCmd)) {
    // `rm` appears in READONLY_SAFE_COMMANDS by historical accident;
    // it is never read-only. Guard against it explicitly.
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
 *
 * Returns true if the operation is catastrophic and must be denied
 * regardless of permission mode.
 */
export function isCatastrophicToolCall(
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory?: string,
): boolean {
  // File-based tools: check file_path
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (filePath && isFileTool(toolName)) {
    return isCatastrophicPath(filePath, workingDirectory);
  }

  // Bash/PowerShell: check command
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

// Re-export types for backward compatibility (PowerShellTool imports these)
export type { SecurityCheckResult, SecurityWarning, Severity } from './safetyConstants.js';

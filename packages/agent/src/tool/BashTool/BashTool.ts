/**
 * BashTool - Enhanced shell command execution tool
 * Adds input validation, security checks, and permission hints
 */

import { execa, ExecaError, type Options } from 'execa';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { BaseTool, ToolExecutionError, ToolPermissionError } from '../BaseTool.js';
import type {
  ToolContext,
  ToolValidationResult,
  PermissionCheckResult,
  RenderedToolMessage,
  ToolProgress,
  ToolInterruptBehavior,
} from '../types.js';
import { z } from 'zod';
import { SandboxManager, getActiveProvider, executeIsolated, wrapCommand } from '../../sandbox/index.js';
import { getShellExecConfig, detectShell } from '../../utils/shellDetector.js';
import {
  tryParseShellCommand,
  hasMalformedTokens,
  getCommandFromTokens,
  hasDangerousShellSyntax,
} from '../../utils/bash/shellQuote.js';
import {
  extractOutputRedirections,
  analyzeCommandComplexity,
} from '../../utils/bash/commands.js';

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface DangerousPattern {
  pattern: RegExp;
  reason: string;
  severity: Severity;
}

// ============================================================================
// Command Normalization (for security detection bypass prevention)
// ============================================================================

/**
 * Normalize command before dangerous-pattern detection.
 *
 * Prevents bypass via:
 * - ANSI escape sequences (color codes, cursor movement)
 * - Null bytes
 * - Unicode fullwidth/halfwidth obfuscation
 */
function normalizeCommandForDetection(command: string): string {
  // Strip ANSI escape sequences (CSI, OSC, DCS, 8-bit C1)
  // Matches: \x1b[...X, \x1b]..., \x90..., \x9b, \x9c, etc.
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
  // e.g., 'ɑ' (U+0251) → 'a', '｡' (U+FF64) → '.'
  command = command.normalize('NFKC');

  // Remove zero-width joiners and spaces that could hide patterns
  command = command.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '');

  return command;
}

// ============================================================
// Dangerous Pattern Definitions
// ============================================================

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // ── Destructive: filesystem ─────────────────────────────────────────────
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
    pattern: /kill\s+-9\s+-1\b/i,
    reason: 'Kill all processes (kill -9 -1)',
    severity: 'critical',
  },
  {
    pattern: /\bpkill\s+-9\b/i,
    reason: 'Force kill all matching processes',
    severity: 'critical',
  },
  {
    pattern: /kill\s+-9\s+1\b/i,
    reason: 'Kill init process',
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
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;:\s*$/i,
    reason: 'Fork bomb',
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

const READONLY_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'type', 'file',
  'stat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'git', 'svn', 'hg', 'node', 'python', 'python3', 'ruby', 'perl', 'php',
  'curl', 'wget', 'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'df', 'du', 'free', 'top', 'ps', 'env', 'id', 'whoami',
  'hostname', 'uname', 'uptime', 'date', 'cal', 'lsblk', 'mount', 'umount',
]);

const READONLY_COMMANDS = new Set([
  'git', 'svn', 'hg', 'npm', 'yarn', 'pnpm',
]);

// ============================================================
// Input Validation
// ============================================================

export interface BashToolInput {
  command: string;
  timeout?: number;
  description?: string;
  background?: boolean;
}

/**
 * Validates BashTool input
 */
export function validateBashInput(input: unknown): { valid: true; data: BashToolInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.command || typeof obj.command !== 'string') {
    return { valid: false, error: 'command must be a string' };
  }

  if (obj.command.trim().length === 0) {
    return { valid: false, error: 'command cannot be empty' };
  }

  if (obj.timeout !== undefined) {
    if (typeof obj.timeout !== 'number' || obj.timeout <= 0) {
      return { valid: false, error: 'timeout must be a positive number' };
    }
    if (obj.timeout > 300000) {
      return { valid: false, error: 'timeout cannot exceed 300000ms (5 minutes)' };
    }
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    return { valid: false, error: 'description must be a string' };
  }

  if (obj.background !== undefined && typeof obj.background !== 'boolean') {
    return { valid: false, error: 'background must be a boolean' };
  }

  return {
    valid: true,
    data: {
      command: obj.command as string,
      timeout: obj.timeout as number | undefined,
      description: obj.description as string | undefined,
      background: obj.background as boolean | undefined,
    },
  };
}

// ============================================================
// Security Checks
// ============================================================

export interface SecurityCheckResult {
  safe: boolean;
  warnings: SecurityWarning[];
  requiresApproval: boolean;
}

export interface SecurityWarning {
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  pattern?: string;
}

/**
 * Execute security check on command
 *
 * Security check runs on the NORMALIZED command to prevent bypass
 * via ANSI codes, invisible chars, or unicode obfuscation.
 */
export function checkSecurity(command: string): SecurityCheckResult {
  // Normalize first to prevent detection bypass
  const normalized = normalizeCommandForDetection(command);

  const warnings: SecurityWarning[] = [];
  let requiresApproval = false;

  // Parse command for deeper analysis
  const parseResult = tryParseShellCommand(normalized);

  // Check for malformed syntax (unclosed quotes)
  if (parseResult.success && hasMalformedTokens(parseResult.tokens)) {
    warnings.push({
      message: 'Command has malformed syntax (unclosed quotes)',
      severity: 'high',
    });
    requiresApproval = true;
  }

  // Check for dangerous shell syntax (command substitution, etc.)
  if (hasDangerousShellSyntax(normalized)) {
    warnings.push({
      message: 'Command contains shell substitution syntax ($() or ` `) which may execute arbitrary code',
      severity: 'high',
    });
    requiresApproval = true;
  }

  // Analyze output redirections
  const redirectionInfo = extractOutputRedirections(normalized);
  if (redirectionInfo.hasDangerousRedirection) {
    warnings.push({
      message: `Output redirection to potentially dangerous target: ${redirectionInfo.redirections.map(r => r.target).join(', ')}`,
      severity: 'high',
    });
    requiresApproval = true;
  }

  // Check for system directory redirections
  for (const redir of redirectionInfo.redirections) {
    if (/^\/(etc|sys|proc|dev|usr|bin|sbin|lib|var)\//.test(redir.target)) {
      warnings.push({
        message: `Writing to system directory: ${redir.target}`,
        severity: 'critical',
      });
      requiresApproval = true;
    }
  }

  // Analyze command complexity
  const complexity = analyzeCommandComplexity(normalized);
  if (complexity.complexity === 'complex') {
    warnings.push({
      message: `Complex command detected (${complexity.pipeCount} pipes, ${complexity.chainCount} chains, subshell: ${complexity.hasSubshell}) - review carefully`,
      severity: 'medium',
    });
  }

  for (const { pattern, reason, severity } of DANGEROUS_PATTERNS) {
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

/**
 * Check if command is read-only
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();

  // Use token-based parsing for more accurate command detection
  const parseResult = tryParseShellCommand(trimmed);
  let firstCmd = trimmed.split(/\s+/)[0].replace(/^sudo\s+/, '');

  // If parsing succeeded, use the parsed command name
  if (parseResult.success && parseResult.tokens.length > 0) {
    const parsedCmd = getCommandFromTokens(parseResult.tokens);
    if (parsedCmd) {
      firstCmd = parsedCmd.replace(/^sudo\s+/, '');
    }
  }

  if (READONLY_SAFE_COMMANDS.has(firstCmd.toLowerCase())) {
    if (/rm\s|-i|--interactive/i.test(trimmed)) {
      return false;
    }
    return true;
  }

  if (READONLY_COMMANDS.has(firstCmd.toLowerCase())) {
    const readonlyGitCommands = ['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'fetch', 'ls-files', 'ls-tree'];
    const gitSubCmd = trimmed.split(/\s+/)[1];
    if (gitSubCmd && readonlyGitCommands.includes(gitSubCmd.toLowerCase())) {
      return true;
    }

    const readonlyNpmCommands = ['ls', 'pack', 'view', 'info', 'search'];
    if (readonlyNpmCommands.includes(gitSubCmd?.toLowerCase() || '')) {
      return true;
    }
  }

  return false;
}

// ============================================================
// Permission Mechanism
// ============================================================

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRequest {
  tool: 'bash';
  command: string;
  reason: string;
  warnings: SecurityWarning[];
  isReadOnly: boolean;
}

export interface PermissionChecker {
  check(request: PermissionRequest): Promise<PermissionDecision>;
}

export class AutoPermissionChecker implements PermissionChecker {
  async check(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.isReadOnly) {
      return 'allow';
    }

    if (request.warnings.some(w => w.severity === 'critical' || w.severity === 'high')) {
      return 'ask';
    }

    if (request.warnings.some(w => w.severity === 'medium')) {
      return 'allow';
    }

    return 'allow';
  }
}

// ============================================================
// Tool Implementation
// ============================================================

export class BashTool extends BaseTool implements ToolExecutor {
  readonly name = 'bash';
  readonly description = 'Execute a bash command. Returns the stdout and stderr output.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 1200000, max: 3600000)',
      },
      description: {
        type: 'string',
        description: 'Optional description for the command',
      },
      background: {
        type: 'boolean',
        description: 'Whether to run the command in background',
      },
    },
    required: ['command'],
  };

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  private defaultTimeout = 1200000; // 20min default
  private permissionChecker: PermissionChecker = new AutoPermissionChecker();
  private killed = false;

  setPermissionChecker(checker: PermissionChecker): void {
    this.permissionChecker = checker;
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult> {
    const validation = validateBashInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { command, timeout, description } = validation.data;
    const resolvedTimeout = timeout ?? this.defaultTimeout;

    const securityResult = checkSecurity(command);
    const isReadOnly = isReadOnlyCommand(command);

    const permissionRequest: PermissionRequest = {
      tool: 'bash',
      command,
      reason: description || 'User requested command execution',
      warnings: securityResult.warnings,
      isReadOnly,
    };

    const decision = await this.permissionChecker.check(permissionRequest);

    if (decision === 'deny') {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Command denied: ${securityResult.warnings.map(w => w.message).join('; ')}`,
        error: true,
      };
    }

    if (decision === 'ask') {
      // Return a special result that StreamingToolExecutor can recognize
      // Format: <tool_use_permission_required>JSON</tool_use_permission_required>
      const permissionInfo = {
        id: crypto.randomUUID(),
        toolName: this.name,
        toolInput: { command, timeout: resolvedTimeout, description },
        mode: 'generic' as const,
        expiresAt: Date.now() + 5 * 60 * 1000,
        decisionReason: securityResult.warnings.map(w => `[${w.severity.toUpperCase()}] ${w.message}`).join('\n'),
      };
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `<tool_use_permission_required>${JSON.stringify(permissionInfo)}</tool_use_permission_required>`,
        error: false,
        metadata: { requiresPermission: true, permissionInfo },
      };
    }

    // Detect shell before try block so it's available in catch
    const shellConfig = getShellExecConfig();
    const shellInfo = detectShell();
    const cwd = workingDirectory || process.cwd();

    try {
      const provider = await getActiveProvider();

      // Docker execution path — full isolation
      if (provider === 'docker') {
        try {
          const sandboxResult = await executeIsolated(command, cwd, {
            filesystem: {
              allowRead: [],
              allowWrite: workingDirectory ? [workingDirectory] : [],
              denyWrite: ['/etc', '/sys', '/proc', '/dev'],
            },
          });

          const output = [sandboxResult.stdout, sandboxResult.stderr]
            .filter(Boolean)
            .join('\n')
            .trim();

          const nonCriticalWarnings = securityResult.warnings.filter(
            w => w.severity !== 'critical' && w.severity !== 'high'
          );

          let resultOutput = output || '(no output)';
          if (nonCriticalWarnings.length > 0) {
            const warningMsg = `[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`;
            resultOutput = `${warningMsg}\n\n${resultOutput}`;
          }

          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: resultOutput,
            error: sandboxResult.exitCode !== 0,
            metadata: {
              exitCode: sandboxResult.exitCode,
              sandboxed: true,
              provider: 'docker',
            },
          };
        } catch (dockerError) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: dockerError instanceof Error ? dockerError.message : 'Docker sandbox error',
            error: true,
            metadata: { sandboxed: true, provider: 'docker' },
          };
        }
      }

      // Non-Docker path: wrap command (bubblewrap or none) then execa
      let finalCommand = await wrapCommand(command, cwd);

      const sanitizedEnv = { ...process.env };
      const sensitiveKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'API_KEY', 'SECRET', 'PASSWORD', 'TOKEN'];
      for (const key of sensitiveKeys) {
        delete sanitizedEnv[key];
      }

      const options: Options = {
        timeout: resolvedTimeout,
        shell: shellConfig.shell,
        env: sanitizedEnv,
        preferLocal: true,
        cwd: workingDirectory,
        cancelSignal: context?.abortController?.signal,
      };

      const nonCriticalWarnings = securityResult.warnings.filter(
        w => w.severity !== 'critical' && w.severity !== 'high'
      );

      const result = await execa(finalCommand, [], options);

      let output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      if (nonCriticalWarnings.length > 0) {
        const warningMsg = `[Warning] ${nonCriticalWarnings.map(w => w.message).join('; ')}`;
        output = `${warningMsg}\n\n${output}`;
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: output || '(no output)',
        metadata: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        },
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: `Command was cancelled: ${command}`,
          error: true,
          metadata: { cancelled: true },
        };
      }

      if (error instanceof ExecaError) {
        const output = [error.stdout, error.stderr]
          .filter(Boolean)
          .join('\n')
          .trim();

        if (error.timedOut) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: `Command timed out (${resolvedTimeout}ms): ${command}\n\n${output}`,
            error: true,
            metadata: { timeout: true, durationMs: resolvedTimeout },
          };
        }

        if (this.killed) {
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: `Command was cancelled: ${output || error.message}`,
            error: true,
            metadata: { cancelled: true },
          };
        }

        // Provide helpful error context for Windows users
        let finalOutput = output || error.message;
        if (process.platform === 'win32' && error.exitCode !== 0) {
          const isCommandNotFound = output.includes('is not recognized') ||
            output.includes('not found') ||
            output.includes('not internal or external command');
          if (isCommandNotFound) {
            const looksUnixSpecific =
              /\b(cat|head|tail|ls|grep|sed|awk|curl|wget|touch|chmod|chown|rm|cp|mv)\b|\/dev\/null|~\//.test(command);
            if (looksUnixSpecific && !shellInfo.supportsUnixCommands) {
              finalOutput = `${finalOutput}\n\n[Note] The current shell (${shellInfo.name}) does not support Unix commands. ` +
                `Consider installing Git Bash for Windows to enable Unix command compatibility.`;
            }
          }
        }

        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: finalOutput,
          error: true,
          metadata: { exitCode: error.exitCode },
        };
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: error instanceof Error ? error.message : 'Unknown error',
        error: true,
      };
    }
  }

  cancel(): void {
    this.killed = true;
  }

  validateInput(input: unknown): ToolValidationResult {
    const result = validateBashInput(input);
    if (!result.valid) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result.data };
  }

  checkPermissions(input: unknown, _context: ToolContext): PermissionCheckResult {
    const validated = validateBashInput(input);
    if (!validated.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }

    const { command } = validated.data;
    const securityResult = checkSecurity(command);
    const isReadOnly = isReadOnlyCommand(command);

    if (!securityResult.safe || securityResult.requiresApproval) {
      return {
        allowed: true,
        requiresUserConfirmation: true,
        reason: securityResult.warnings.map(w => w.message).join('; '),
      };
    }

    return { allowed: true };
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    const exitCode = result.metadata?.exitCode as number | undefined;
    const durationMs = result.metadata?.durationMs as number | undefined;

    let output = result.result;
    if (durationMs !== undefined) {
      output = `[Completed in ${durationMs}ms]\n${output}`;
    }
    if (exitCode !== undefined && exitCode !== 0) {
      output = `[Exit code: ${exitCode}]\n${output}`;
    }

    const lines = result.result.split('\n').length;
    if (lines > 50) {
      const preview = result.result.split('\n').slice(0, 20).join('\n');
      return {
        type: 'code',
        content: `${output}\n\n[... ${lines - 20} more lines]`,
        metadata: { ...result.metadata, lineCount: lines },
      };
    }

    return {
      type: 'text',
      content: output,
      metadata: result.metadata,
    };
  }

  renderToolUsePendingMessage(): RenderedToolMessage {
    return {
      type: 'text',
      content: 'Waiting for command execution...',
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj.command as string | undefined;
      if (cmd) {
        const preview = cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
        return `bash: ${preview}`;
      }
    }
    return 'bash';
  }
}

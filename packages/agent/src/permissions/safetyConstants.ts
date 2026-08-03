/**
 * Safety constants for the unified SecurityPolicy layer.
 *
 * Two tiers:
 *   - CATASTROPHIC: operations that brick the system or cause
 *     unrecoverable damage. NEVER bypassed, even in bypassPermissions
 *     mode.
 *   - SOFT: suspicious operations that require user confirmation in
 *     normal mode but are skipped in bypass mode.
 *
 * Split adapted from the original hardcoded lists in WriteTool.ts
 * (BLOCKED_PATHS_*) and BashTool.ts (DANGEROUS_PATTERNS).
 */

// ============================================================================
// Shared Types
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
// Path Safety
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
 *
 * On Unix, /dev block devices (sd*, disk*, loop*, nvme*, mapper*,
 * vd*, xvd*) are catastrophic — writing to them destroys filesystems.
 * /dev/null and /dev/zero are safe and deliberately excluded (they
 * fall through to the soft /dev catch-all).
 *
 * On Windows, System32/SysWOW64 are catastrophic — corrupting them
 * bricks the OS boot path. Matched as directory-style (a file directly
 * inside System32 or a subdirectory).
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
 *
 * /dev catch-all covers non-block-device /dev paths (e.g. /dev/random,
 * /dev/abuse) that are suspicious but not system-bricking.
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
// Bash Command Safety
// ============================================================================

/**
 * Bash commands that cause catastrophic, unrecoverable system damage.
 * NEVER bypassed, even in bypassPermissions mode.
 *
 * Only operations that brick the OS (format, block device write,
 * recursive root delete, fork bomb, kill all processes) belong here.
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
 *
 * Includes: mass deletion, system config modification, privilege
 * escalation, reverse shells, secret exfiltration, destructive git
 * operations, SQL destruction, and process termination.
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

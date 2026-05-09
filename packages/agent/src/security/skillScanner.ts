/**
 * Skill Security Scanner
 *
 * Scans skill content for security threats before installation.
 * Used when loading skills from external sources (MCP, skills hub, etc.)
 *
 * Categories:
 * - Prompt injection (role hijack, bypass restrictions, hidden instructions)
 * - Exfiltration (env vars, secrets, credentials)
 * - Destructive operations (rm -rf, chmod 777, etc.)
 * - Persistence (crontab, SSH keys, shell rc files)
 * - Network (reverse shells, tunnels, exfil services)
 * - Obfuscation (base64, hex encoding, eval)
 * - Privilege escalation (sudo, suid, sudoers)
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Verdict = 'safe' | 'caution' | 'dangerous';
export type Category =
  | 'injection'
  | 'exfiltration'
  | 'destructive'
  | 'persistence'
  | 'network'
  | 'obfuscation'
  | 'execution'
  | 'privilege_escalation'
  | 'credential_exposure'
  | 'structural';

export interface SkillFinding {
  patternId: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface SkillScanResult {
  skillName: string;
  source: string;
  verdict: Verdict;
  findings: SkillFinding[];
  summary: string;
}

export interface TrustLevel {
  level: 'builtin' | 'trusted' | 'community' | 'agent-created';
  source: string;
}

// ============================================================================
// Threat Patterns
// ============================================================================

const SKILL_THREAT_PATTERNS: [RegExp, string, Severity, Category, string][] = [
  // ── Prompt injection ────────────────────────────────────────────────────
  [
    /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i,
    'prompt_injection_ignore',
    'critical',
    'injection',
    'Prompt injection: ignore previous instructions',
  ],
  [
    /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i,
    'deception_hide',
    'critical',
    'injection',
    'Instructs agent to hide information from user',
  ],
  [
    /system\s+prompt\s+override/i,
    'sys_prompt_override',
    'critical',
    'injection',
    'Attempts to override the system prompt',
  ],
  [
    /disregard\s+(?:\w+\s+)*(your|all|any)\s+(instructions|rules|guidelines)/i,
    'disregard_rules',
    'critical',
    'injection',
    'Instructs agent to disregard its rules',
  ],
  [
    /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    'bypass_restrictions',
    'critical',
    'injection',
    'Instructs agent to bypass restrictions',
  ],
  [
    /you\s+are\s+now\s+/i,
    'role_hijack',
    'high',
    'injection',
    'Attempts to override the agent role',
  ],
  [
    /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i,
    'role_pretend',
    'high',
    'injection',
    'Attempts to make agent assume different identity',
  ],
  [
    /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i,
    'leak_system_prompt',
    'high',
    'injection',
    'Attempts to extract the system prompt',
  ],
  [
    /(when|if)\s+no\s+one\s+is\s+(watching|looking)/i,
    'conditional_deception',
    'high',
    'injection',
    'Conditional instruction for unobserved behavior',
  ],
  [
    /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    'html_comment_injection',
    'high',
    'injection',
    'Hidden instructions in HTML comment',
  ],
  [
    /<\s*div\s+style\s*=\s*["'][^"]*display\s*:\s*none/i,
    'hidden_div',
    'high',
    'injection',
    'Hidden HTML div (invisible instructions)',
  ],
  [
    /\bDAN\s+mode\b|Do\s+Anything\s+Now/i,
    'jailbreak_dan',
    'critical',
    'injection',
    'DAN jailbreak attempt',
  ],
  [
    /developer\s+mode\b.*\benabled?\b/i,
    'jailbreak_dev_mode',
    'critical',
    'injection',
    'Developer mode jailbreak',
  ],
  [
    /for\s+educational\s+purposes?\s+only/i,
    'educational_pretext',
    'medium',
    'injection',
    'Educational pretext for harmful content',
  ],
  [
    /respond\s+without\s+(?:restrictions?|limitations?|filters?|safety)/i,
    'remove_filters',
    'critical',
    'injection',
    'Instructs agent to remove safety filters',
  ],

  // ── Exfiltration: env secrets ──────────────────────────────────────────
  [
    /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    'env_exfil_curl',
    'critical',
    'exfiltration',
    'Curl command interpolating secret environment variable',
  ],
  [
    /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    'env_exfil_wget',
    'critical',
    'exfiltration',
    'Wget command interpolating secret environment variable',
  ],
  [
    /printenv|env\s*\|/i,
    'dump_all_env',
    'high',
    'exfiltration',
    'Dumps all environment variables',
  ],
  [
    /os\.environ\b(?!\s*\.get\s*\(\s*["\']PATH["\'])/i,
    'python_os_environ',
    'high',
    'exfiltration',
    'Accesses os.environ (potential env dump)',
  ],
  [
    /os\.getenv\s*\([^)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    'python_getenv_secret',
    'critical',
    'exfiltration',
    'Reads secret via os.getenv()',
  ],
  [
    /process\.env\[/i,
    'node_process_env',
    'high',
    'exfiltration',
    'Accesses process.env (Node.js environment)',
  ],
  [
    /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    'read_secrets_file',
    'critical',
    'exfiltration',
    'Reads known secrets file',
  ],
  [
    /\$(HOME|\{HOME\})\/\.ssh|\~\/\.ssh/i,
    'ssh_dir_access',
    'high',
    'exfiltration',
    'References user SSH directory',
  ],
  [
    /\$(HOME|\{HOME\})\/\.aws|\~\/\.aws/i,
    'aws_dir_access',
    'high',
    'exfiltration',
    'References user AWS credentials directory',
  ],
  [
    /\$(HOME|\{HOME\})\/\.gnupg|\~\/\.gnupg/i,
    'gpg_dir_access',
    'high',
    'exfiltration',
    'References user GPG keyring',
  ],
  [
    /\$(HOME|\{HOME\})\/\.kube|\~\/\.kube/i,
    'kube_dir_access',
    'high',
    'exfiltration',
    'References Kubernetes config directory',
  ],

  // ── Destructive operations ───────────────────────────────────────────────
  [/rm\s+-rf\s+\//i, 'destructive_root_rm', 'critical', 'destructive', 'Recursive delete from root'],
  [/rm\s+-[rfv]+\s+.*\$HOME|\brmdir\s+.*\$HOME/i, 'destructive_home_rm', 'critical', 'destructive', 'Recursive delete targeting home directory'],
  [/chmod\s+777/i, 'insecure_perms', 'medium', 'destructive', 'Sets world-writable permissions'],
  [/>\s*\/etc\//i, 'system_overwrite', 'critical', 'destructive', 'Overwrites system configuration file'],
  [/\bmkfs\b/i, 'format_filesystem', 'critical', 'destructive', 'Formats a filesystem'],
  [/\bdd\s+.*if=.*of=\/dev\//i, 'disk_overwrite', 'critical', 'destructive', 'Raw disk write operation'],
  [/shutil\.rmtree\s*\(\s*["\'][/]/i, 'python_rmtree', 'high', 'destructive', 'Python rmtree on absolute path'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;:/i, 'fork_bomb', 'critical', 'destructive', 'Fork bomb'],

  // ── Persistence ────────────────────────────────────────────────────────
  [/\bcrontab\b/i, 'persistence_cron', 'medium', 'persistence', 'Modifies cron jobs'],
  [/\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)/i, 'shell_rc_mod', 'medium', 'persistence', 'References shell startup file'],
  [/authorized_keys/i, 'ssh_backdoor', 'critical', 'persistence', 'Modifies SSH authorized keys (backdoor)'],
  [/ssh-keygen/i, 'ssh_keygen', 'medium', 'persistence', 'Generates SSH keys'],
  [/systemd.*\.service|systemctl\s+(enable|start)/i, 'systemd_service', 'medium', 'persistence', 'References systemd service'],
  [/\/etc\/sudoers|visudo/i, 'sudoers_mod', 'critical', 'persistence', 'Modifies sudoers (privilege escalation)'],
  [/git\s+config\s+--global/i, 'git_config_global', 'medium', 'persistence', 'Modifies global git configuration'],

  // ── Network ──────────────────────────────────────────────────────────────
  [/\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b/i, 'reverse_shell', 'critical', 'network', 'Potential reverse shell listener'],
  [/\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i, 'tunnel_service', 'high', 'network', 'Uses tunneling service for external access'],
  [/\/bin\/(ba)?sh\s+-i\s+.*>\/dev\/tcp\//i, 'bash_reverse_shell', 'critical', 'network', 'Bash interactive reverse shell'],
  [/\bpython[23]?\s+-c\s+["']import\s+socket/i, 'python_socket_oneliner', 'critical', 'network', 'Python one-liner socket (likely reverse shell)'],
  [/webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i, 'exfil_service', 'high', 'network', 'References known exfiltration service'],
  [/pastebin\.com|hastebin\.com|ghostbin\./i, 'paste_service', 'medium', 'network', 'References paste service (possible staging)'],

  // ── Obfuscation ─────────────────────────────────────────────────────────
  [/base64\s+(-d|--decode)\s*\|/i, 'base64_decode_pipe', 'high', 'obfuscation', 'base64 decodes and pipes to execution'],
  [/\beval\s*\(\s*["\']/i, 'eval_string', 'high', 'obfuscation', 'eval() with string argument'],
  [/\bexec\s*\(\s*["\']/i, 'exec_string', 'high', 'obfuscation', 'exec() with string argument'],
  [/echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/i, 'echo_pipe_exec', 'critical', 'obfuscation', 'echo piped to interpreter for execution'],
  [/\bcompile\s*\([^)]+,\s*["\'][^"\']+["\']\s*,\s*["\']exec["\']\s*\)/i, 'python_compile_exec', 'high', 'obfuscation', 'Python compile() with exec mode'],
  [/getattr\s*\(\s*__builtins__/i, 'python_getattr_builtins', 'high', 'obfuscation', 'Dynamic access to Python builtins'],
  [/__import__\s*\(\s*["\']os["\']\s*\)/i, 'python_import_os', 'high', 'obfuscation', 'Dynamic import of os module'],

  // ── Execution ───────────────────────────────────────────────────────────
  [/subprocess\.(run|call|Popen|check_output)\s*\(/i, 'python_subprocess', 'medium', 'execution', 'Python subprocess execution'],
  [/os\.system\s*\(/i, 'python_os_system', 'high', 'execution', 'os.system() unguarded shell execution'],
  [/os\.popen\s*\(/i, 'python_os_popen', 'high', 'execution', 'os.popen() shell pipe execution'],
  [/child_process\.(exec|spawn|fork)\s*\(/i, 'node_child_process', 'high', 'execution', 'Node.js child_process execution'],
  [/`[^`]*\$\([^)]+\)[^`]*`/i, 'backtick_subshell', 'medium', 'execution', 'Backtick with command substitution'],

  // ── Privilege escalation ─────────────────────────────────────────────────
  [/\bsudo\b/i, 'sudo_usage', 'high', 'privilege_escalation', 'Uses sudo (privilege escalation)'],
  [/setuid|setgid|cap_setuid/i, 'setuid_setgid', 'critical', 'privilege_escalation', 'setuid/setgid privilege escalation'],
  [/NOPASSWD/i, 'nopasswd_sudo', 'critical', 'privilege_escalation', 'NOPASSWD sudoers entry'],
  [/chmod\s+[u+]?s/i, 'suid_bit', 'critical', 'privilege_escalation', 'Sets SUID/SGID bit'],

  // ── Credential exposure ──────────────────────────────────────────────────
  [/(?:api[_-]?key|token|secret|password)\s*[=:]\s*["\'][A-Za-z0-9+/=_-]{20,}/i, 'hardcoded_secret', 'critical', 'credential_exposure', 'Possible hardcoded API key/token/secret'],
  [/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, 'embedded_private_key', 'critical', 'credential_exposure', 'Embedded private key'],
  [/(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,})/i, 'github_token_leaked', 'critical', 'credential_exposure', 'GitHub personal access token'],
  [/sk-[A-Za-z0-9]{20,}/i, 'openai_key_leaked', 'critical', 'credential_exposure', 'Possible OpenAI API key'],
  [/sk-ant-[A-Za-z0-9_-]{90,}/i, 'anthropic_key_leaked', 'critical', 'credential_exposure', 'Possible Anthropic API key'],
  [/AKIA[0-9A-Z]{16}/i, 'aws_access_key_leaked', 'critical', 'credential_exposure', 'AWS access key ID'],

  // ── Agent config persistence ────────────────────────────────────────────
  [/AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules/i, 'agent_config_mod', 'critical', 'persistence', 'References agent config files (could persist malicious instructions)'],
  [/\.duya\/config\.yaml|\.duya\/SOUL\.md/i, 'duya_config_mod', 'critical', 'persistence', 'References DUYA configuration files'],

  // ── Supply chain ────────────────────────────────────────────────────────
  [/curl\s+[^\n]*\|\s*(ba)?sh/i, 'curl_pipe_shell', 'critical', 'exfiltration', 'curl piped to shell (download-and-execute)'],
  [/wget\s+[^\n]*\|\s*(ba)?sh/i, 'wget_pipe_shell', 'critical', 'exfiltration', 'wget piped to shell (download-and-execute)'],
  [/curl\s+[^\n]*\|\s*python/i, 'curl_pipe_python', 'critical', 'exfiltration', 'curl piped to Python interpreter'],
];

// Invisible unicode characters
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\u2062', '\u2063', '\u2064',
  '\ufeff', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
  '\u2066', '\u2067', '\u2068', '\u2069',
]);

// Structural limits
const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_KB = 1024;
const MAX_SINGLE_FILE_KB = 256;

const SCANNABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.sh', '.bash', '.js', '.ts', '.rb',
  '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.conf',
  '.html', '.css', '.xml', '.tex', '.r', '.jl', '.pl', '.php',
]);

const SUSPICIOUS_BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.com',
  '.msi', '.dmg', '.app', '.deb', '.rpm',
]);

// ============================================================================
// Trust Levels
// ============================================================================

const TRUSTED_REPOS = new Set(['openai/skills', 'anthropics/skills']);

// Policy: [safe, caution, dangerous] → decision
type PolicyDecision = 'allow' | 'block' | 'ask';

const INSTALL_POLICY: Record<string, readonly [PolicyDecision, PolicyDecision, PolicyDecision]> = {
  builtin: ['allow', 'allow', 'allow'],
  trusted: ['allow', 'allow', 'block'],
  community: ['allow', 'block', 'block'],
  'agent-created': ['allow', 'allow', 'ask'],
};

const VERDICT_INDEX: Record<Verdict, 0 | 1 | 2> = {
  safe: 0,
  caution: 1,
  dangerous: 2,
};

// ============================================================================
// Scanner
// ============================================================================

/**
 * Scan a single file for threat patterns and invisible unicode.
 */
export function scanSkillFile(
  content: string,
  filename: string,
): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  // Pattern matching
  for (const [pattern, patternId, severity, category, description] of SKILL_THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const key = `${patternId}:${i}`;
      if (seen.has(key)) continue;

      if (pattern.test(lines[i])) {
        seen.add(key);
        const match = lines[i].trim();
        findings.push({
          patternId,
          severity,
          category,
          file: filename,
          line: i + 1,
          match: match.length > 100 ? match.substring(0, 97) + '...' : match,
          description,
        });
      }
    }
  }

  // Invisible unicode
  for (let i = 0; i < lines.length; i++) {
    for (const char of INVISIBLE_CHARS) {
      if (lines[i].includes(char)) {
        findings.push({
          patternId: 'invisible_unicode',
          severity: 'high',
          category: 'injection',
          file: filename,
          line: i + 1,
          match: `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
          description: `Invisible unicode character for text hiding/injection`,
        });
        break;
      }
    }
  }

  return findings;
}

/**
 * Scan a skill directory for security threats.
 */
export function scanSkill(
  skillPath: string,
  source: string,
  files?: Map<string, string>, // filename → content
): SkillScanResult {
  const skillName = skillPath.split('/').pop() || skillPath;
  const trustLevel = resolveTrustLevel(source);

  // If files content is provided, scan each
  if (files) {
    const allFindings: SkillFinding[] = [];
    for (const [filename, content] of files) {
      if (isScannableFile(filename)) {
        allFindings.push(...scanSkillFile(content, filename));
      }
    }
    return makeResult(skillName, source, trustLevel, allFindings);
  }

  // No content provided - return safe (file-based scanning done externally)
  return {
    skillName,
    source,
    verdict: 'safe',
    findings: [],
    summary: `${skillName}: no content provided for scanning`,
  };
}

/**
 * Determine overall verdict from findings.
 */
function determineVerdict(findings: SkillFinding[]): Verdict {
  if (findings.length === 0) return 'safe';
  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasHigh = findings.some((f) => f.severity === 'high');
  if (hasCritical) return 'dangerous';
  if (hasHigh) return 'caution';
  return 'caution';
}

/**
 * Determine if skill should be allowed based on verdict and trust.
 */
export function shouldAllowInstall(
  verdict: Verdict,
  trustLevel: string,
  force: boolean = false,
): { allowed: boolean | null; reason: string } {
  const policy = INSTALL_POLICY[trustLevel] ?? INSTALL_POLICY.community;
  const idx = VERDICT_INDEX[verdict];
  const decision = policy[idx];

  if (decision === 'allow') {
    return { allowed: true, reason: `Allowed (${trustLevel} source, ${verdict} verdict)` };
  }

  if (force) {
    return {
      allowed: true,
      reason: `Force-installed despite ${verdict} verdict`,
    };
  }

  if (decision === 'ask') {
    return { allowed: null, reason: `Requires confirmation (${trustLevel} + ${verdict})` };
  }

  return { allowed: false, reason: `Blocked (${trustLevel} + ${verdict})` };
}

/**
 * Format a scan result as a human-readable report.
 */
export function formatScanReport(result: SkillScanResult): string {
  const lines: string[] = [];

  lines.push(`Scan: ${result.skillName} (${result.source})  Verdict: ${result.verdict.toUpperCase()}`);

  if (result.findings.length > 0) {
    const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...result.findings].sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
    );

    for (const f of sorted) {
      const sev = f.severity.toUpperCase().padEnd(8);
      const loc = `${f.file}:${f.line}`.padEnd(30);
      lines.push(`  ${sev} [${f.category}] ${loc} "${f.match}"`);
    }
    lines.push('');
  }

  const { allowed, reason } = shouldAllowInstall(result.verdict, result.source);
  const status = allowed === true ? 'ALLOWED' : allowed === null ? 'NEEDS CONFIRMATION' : 'BLOCKED';
  lines.push(`Decision: ${status} — ${reason}`);

  return lines.join('\n');
}

// ============================================================================
// Internal helpers
// ============================================================================

function resolveTrustLevel(source: string): TrustLevel['level'] {
  if (source === 'builtin' || source.startsWith('official/')) return 'builtin';
  if (source === 'agent-created') return 'agent-created';
  for (const trusted of TRUSTED_REPOS) {
    if (source.startsWith(trusted)) return 'trusted';
  }
  return 'community';
}

function isScannableFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  // SKILL.md always scannable even if extension not in list
  if (filename === 'SKILL.md' || filename.endsWith('.md')) return true;
  return SCANNABLE_EXTENSIONS.has(filename.substring(filename.lastIndexOf('.')));
}

function makeResult(
  skillName: string,
  source: string,
  trustLevel: TrustLevel['level'],
  findings: SkillFinding[],
): SkillScanResult {
  const verdict = determineVerdict(findings);
  const categories = [...new Set(findings.map((f) => f.category))];
  const summary = findings.length === 0
    ? `${skillName}: clean scan, no threats detected`
    : `${skillName}: ${verdict} — ${findings.length} finding(s) in ${categories.join(', ')}`;

  return { skillName, source, verdict, findings, summary };
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const SkillFindingSchema = z.object({
  patternId: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.string(),
  file: z.string(),
  line: z.number(),
  match: z.string(),
  description: z.string(),
});

export const SkillScanResultSchema = z.object({
  skillName: z.string(),
  source: z.string(),
  verdict: z.enum(['safe', 'caution', 'dangerous']),
  findings: z.array(SkillFindingSchema),
  summary: z.string(),
});

export type SkillScanResultInput = z.infer<typeof SkillScanResultSchema>;

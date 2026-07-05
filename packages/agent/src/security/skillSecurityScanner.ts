/**
 * Skill security scanner — basic threat pattern detection.
 *
 * Inspired by hermes-agent's `tools/skills_guard.py`.
 *
 * Scans SKILL.md content and support files for dangerous patterns:
 * - Data exfiltration (curl/wget with secrets, reading .ssh/.aws)
 * - Prompt injection ("ignore previous instructions", role hijacking)
 * - Destructive operations (rm -rf /, mkfs, dd to device)
 * - Persistence (crontab, .bashrc, authorized_keys)
 * - Obfuscation (base64 decode pipelines, eval/exec)
 *
 * Returns a verdict: safe / caution / dangerous
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type SecurityVerdict = 'safe' | 'caution' | 'dangerous';

export interface SecurityFinding {
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
}

export interface ScanResult {
  verdict: SecurityVerdict;
  findings: SecurityFinding[];
  file: string;
}

// ----------------------------------------------------------------------------
// Threat patterns
// ----------------------------------------------------------------------------

interface ThreatPattern {
  regex: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // --- Data exfiltration ---
  {
    regex: /curl\s+.*\b(api[_-]?key|token|secret|password|credential)\b/i,
    severity: 'critical',
    category: 'data-exfil',
    description: 'curl with potential secret in URL',
  },
  {
    regex: /wget\s+.*\b(api[_-]?key|token|secret|password)\b/i,
    severity: 'critical',
    category: 'data-exfil',
    description: 'wget with potential secret in URL',
  },
  {
    regex: /cat\s+~?\/\.ssh\/|cat\s+~?\/\.aws\/|cat\s+~?\/\.kube\//i,
    severity: 'critical',
    category: 'data-exfil',
    description: 'Reading credential files (.ssh/.aws/.kube)',
  },
  {
    regex: /os\.environ\.get\s*\(\s*['"](?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i,
    severity: 'high',
    category: 'data-exfil',
    description: 'Reading secrets from environment',
  },
  {
    regex: /\b webhook\.site\b/i,
    severity: 'critical',
    category: 'data-exfil',
    description: 'webhook.site exfiltration endpoint',
  },

  // --- Prompt injection ---
  {
    regex: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
    severity: 'critical',
    category: 'prompt-injection',
    description: 'Classic prompt injection: "ignore previous instructions"',
  },
  {
    regex: /you\s+are\s+(?:now|actually)\s+(?:a|an)\s+(?:root|admin|unrestricted)/i,
    severity: 'critical',
    category: 'prompt-injection',
    description: 'Role hijacking attempt',
  },
  {
    regex: /do\s+not\s+(?:tell|inform|warn)\s+the\s+user/i,
    severity: 'critical',
    category: 'prompt-injection',
    description: 'Suppression of user notification',
  },
  {
    regex: /\bDAN\b.*\bmode\b/i,
    severity: 'high',
    category: 'prompt-injection',
    description: 'DAN jailbreak pattern',
  },

  // --- Destructive operations ---
  {
    regex: /rm\s+-rf?\s+\/(?:\s|$)/,
    severity: 'critical',
    category: 'destructive',
    description: 'rm -rf / (root filesystem deletion)',
  },
  {
    regex: /mkfs\./i,
    severity: 'critical',
    category: 'destructive',
    description: 'Filesystem format command',
  },
  {
    regex: /dd\s+if=.*of=\/dev\//i,
    severity: 'critical',
    category: 'destructive',
    description: 'dd writing to device',
  },
  {
    regex: /chmod\s+777\s+\//i,
    severity: 'high',
    category: 'destructive',
    description: 'chmod 777 on root path',
  },

  // --- Persistence ---
  {
    regex: /crontab\s+-[er]/i,
    severity: 'high',
    category: 'persistence',
    description: 'crontab modification',
  },
  {
    regex: /echo.*>>?\s*~?\/\.bashrc/i,
    severity: 'high',
    category: 'persistence',
    description: 'Writing to .bashrc',
  },
  {
    regex: /authorized_keys/i,
    severity: 'high',
    category: 'persistence',
    description: 'authorized_keys manipulation',
  },
  {
    regex: /systemctl\s+(?:enable|start|create)/i,
    severity: 'medium',
    category: 'persistence',
    description: 'systemd service creation',
  },

  // --- Obfuscation ---
  {
    regex: /\bbase64\b.*\bdecode\b|\bdecode\b.*\bbase64\b/i,
    severity: 'high',
    category: 'obfuscation',
    description: 'base64 decode pipeline (potential obfuscation)',
  },
  {
    regex: /\beval\s*\(/i,
    severity: 'high',
    category: 'obfuscation',
    description: 'eval() call (dynamic code execution)',
  },
  {
    regex: /\bexec\s*\(/i,
    severity: 'high',
    category: 'obfuscation',
    description: 'exec() call (dynamic code execution)',
  },
  {
    regex: /importlib\.import_module\s*\(/i,
    severity: 'medium',
    category: 'obfuscation',
    description: 'Dynamic module loading',
  },

  // --- Supply chain ---
  {
    regex: /curl\s+.*\|\s*(?:sh|bash|zsh)/i,
    severity: 'critical',
    category: 'supply-chain',
    description: 'curl pipe to shell (remote code execution)',
  },
  {
    regex: /pip\s+install\s+(?!.*==)/i,
    severity: 'medium',
    category: 'supply-chain',
    description: 'pip install without version pinning',
  },
  {
    regex: /npm\s+install\s+-g/i,
    severity: 'medium',
    category: 'supply-chain',
    description: 'Global npm install',
  },

  // --- Privilege escalation ---
  {
    regex: /\bsudo\b/i,
    severity: 'medium',
    category: 'privilege-escalation',
    description: 'sudo usage',
  },
  {
    regex: /setuid|NOPASSWD/i,
    severity: 'high',
    category: 'privilege-escalation',
    description: 'setuid or NOPASSWD (privilege escalation)',
  },

  // --- Credential exposure ---
  {
    regex: /\b(sk-ant-|sk-proj-|AKIA|ghp_|gho_|xox[baprs]-)/i,
    severity: 'critical',
    category: 'credential-exposure',
    description: 'Hardcoded API key pattern detected',
  },
  {
    regex: /\b(?:PRIVATE\s+KEY|BEGIN\s+RSA\s+PRIVATE)\b/i,
    severity: 'critical',
    category: 'credential-exposure',
    description: 'Embedded private key',
  },
];

// ----------------------------------------------------------------------------
// Scanner
// ----------------------------------------------------------------------------

/**
 * Scan file content for security threats.
 *
 * @param content The file content to scan
 * @param fileName The name of the file (for reporting)
 * @returns Scan result with verdict and findings
 */
export function scanSkillContent(
  content: string,
  fileName: string = 'SKILL.md'
): ScanResult {
  const findings: SecurityFinding[] = [];

  for (const pattern of THREAT_PATTERNS) {
    const match = pattern.regex.exec(content);
    if (match) {
      findings.push({
        pattern: match[0],
        severity: pattern.severity,
        category: pattern.category,
        description: pattern.description,
      });
    }
  }

  // Determine verdict: dangerous if any critical, caution if any high
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh = findings.some(f => f.severity === 'high');
  const verdict: SecurityVerdict = hasCritical ? 'dangerous' : (hasHigh ? 'caution' : 'safe');

  return { verdict, findings, file: fileName };
}

/**
 * Determine if a skill should be allowed based on its security verdict.
 *
 * - 'dangerous' → blocked (not allowed)
 * - 'caution' → allowed with warning (null)
 * - 'safe' → allowed (true)
 *
 * For bundled skills, always allow (they ship with the product).
 */
export function shouldAllowSkill(
  verdict: SecurityVerdict,
  source: string
): boolean | null {
  if (source === 'bundled') return true;
  if (verdict === 'dangerous') return false;
  if (verdict === 'caution') return null;
  return true;
}

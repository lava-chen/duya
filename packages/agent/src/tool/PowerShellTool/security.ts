import type { SecurityCheckResult, SecurityWarning } from '../BashTool/BashTool.js';

type Severity = SecurityWarning['severity'];

interface PatternRule {
  pattern: RegExp;
  message: string;
  severity: Severity;
}

const POWERSHELL_DANGEROUS_PATTERNS: PatternRule[] = [
  {
    pattern: /\b(remove-item|rm|del|erase|rmdir)\b/i,
    message: 'Command removes files or directories',
    severity: 'high',
  },
  {
    pattern: /\b(set-content|add-content|out-file|new-item|clear-content|rename-item|copy-item|move-item)\b/i,
    message: 'Command writes or mutates filesystem content',
    severity: 'high',
  },
  {
    pattern: /\b(invoke-expression|iex|start-process)\b/i,
    message: 'Command can execute arbitrary processes or code',
    severity: 'critical',
  },
  {
    pattern: /\b(stop-process|kill-process|restart-computer|stop-computer)\b/i,
    message: 'Command can terminate processes or the machine',
    severity: 'critical',
  },
  {
    pattern: /\b(set-executionpolicy|add-type|new-object)\b/i,
    message: 'Command can alter runtime behavior or load executable code',
    severity: 'high',
  },
  {
    pattern: /\b(invoke-webrequest|iwr|invoke-restmethod|irm)\b.*\|\s*(invoke-expression|iex)\b/i,
    message: 'Command downloads remote content and executes it',
    severity: 'critical',
  },
  {
    pattern: />{1,2}\s*[^|]+/i,
    message: 'Command writes output using shell redirection',
    severity: 'medium',
  },
];

const READONLY_CMDLETS = new Set([
  'get-childitem',
  'get-content',
  'get-item',
  'get-itemproperty',
  'get-itempropertyvalue',
  'get-location',
  'get-process',
  'get-service',
  'get-date',
  'get-history',
  'get-computerinfo',
  'get-host',
  'get-psdrive',
  'get-psprovider',
  'get-timezone',
  'test-path',
  'resolve-path',
  'select-string',
  'sort-object',
  'where-object',
  'select-object',
  'measure-object',
  'format-table',
  'format-list',
  'format-wide',
  'write-output',
]);

const READONLY_ALIASES: Record<string, string> = {
  cat: 'get-content',
  dir: 'get-childitem',
  echo: 'write-output',
  gci: 'get-childitem',
  gc: 'get-content',
  gl: 'get-location',
  ls: 'get-childitem',
  pwd: 'get-location',
  ps: 'get-process',
  sls: 'select-string',
  type: 'get-content',
};

const READONLY_COMPOUND_SEPARATORS = /&&|\|\||;|>(?!\s*&1)|>>/;

function normalizeCommand(command: string): string {
  return command
    .replace(/\x00/g, '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .trim();
}

function resolvePowerShellCommandName(command: string): string {
  const firstToken = command.split(/\s+/)[0]?.toLowerCase() ?? '';
  return READONLY_ALIASES[firstToken] ?? firstToken;
}

export function checkPowerShellSecurity(command: string): SecurityCheckResult {
  const normalized = normalizeCommand(command);
  const warnings: SecurityWarning[] = [];
  let requiresApproval = false;

  if (/\$\(|@\(|\$\{/.test(normalized)) {
    warnings.push({
      message: 'Command contains PowerShell subexpressions or expandable expressions',
      severity: 'high',
    });
    requiresApproval = true;
  }

  if (/`$/.test(normalized) || /`[rn0abfv]/i.test(normalized)) {
    warnings.push({
      message: 'Command uses PowerShell escape/backtick syntax',
      severity: 'medium',
    });
  }

  if (READONLY_COMPOUND_SEPARATORS.test(normalized)) {
    warnings.push({
      message: 'Command chains multiple statements or writes through redirection',
      severity: 'medium',
    });
  }

  for (const rule of POWERSHELL_DANGEROUS_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      warnings.push({
        message: rule.message,
        severity: rule.severity,
        pattern: rule.pattern.source,
      });
      if (rule.severity === 'critical' || rule.severity === 'high') {
        requiresApproval = true;
      }
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
    requiresApproval,
  };
}

export function isReadOnlyPowerShellCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (READONLY_COMPOUND_SEPARATORS.test(normalized)) return false;
  if (/\$\(|@\(|\$\{/.test(normalized)) return false;

  const canonical = resolvePowerShellCommandName(normalized);
  if (READONLY_CMDLETS.has(canonical)) {
    return true;
  }

  if (canonical === 'git') {
    const subcommand = normalized.split(/\s+/)[1]?.toLowerCase() ?? '';
    return ['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'fetch', 'ls-files', 'ls-tree'].includes(subcommand);
  }

  if (canonical === 'npm') {
    const subcommand = normalized.split(/\s+/)[1]?.toLowerCase() ?? '';
    return ['ls', 'view', 'info', 'search', 'pack'].includes(subcommand);
  }

  return false;
}

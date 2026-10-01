import type { RiskLevel, ImportItemType } from '../types';

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"][^'"]+['"]/gi, type: 'API Key' },
  { pattern: /(?:token|secret|password|auth)\s*[:=]\s*['"][^'"]+['"]/gi, type: 'Token/Secret' },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, type: 'Private Key' },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/, type: 'GitHub Token' },
  { pattern: /sk-[A-Za-z0-9]{32,}/, type: 'OpenAI Key' },
  { pattern: /AIza[0-9A-Za-z\-_]{35}/, type: 'Google API Key' },
];

export function redactSecrets(content: string): {
  cleanContent: string;
  hasSecrets: boolean;
  secretTypes: string[];
} {
  let hasSecrets = false;
  const secretTypes: string[] = [];
  let cleanContent = content;

  for (const { pattern, type } of SENSITIVE_PATTERNS) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      hasSecrets = true;
      secretTypes.push(type);
      cleanContent = cleanContent.replace(pattern, '[REDACTED]');
    }
  }

  return { cleanContent, hasSecrets, secretTypes };
}

export function assessRisk(type: ImportItemType, content: string): RiskLevel {
  const { hasSecrets } = redactSecrets(content);
  if (hasSecrets) return 'restricted';
  if (type === 'hook') return 'restricted';
  if (type === 'mcp') return 'review';
  if (type === 'project_memory') return 'review';
  return 'safe';
}
/**
 * Context File Security Scanner
 *
 * Scans context files (AGENTS.md, ARCHITECTURE.md, SOUL.md, etc.) for
 * prompt injection attacks before they are loaded into the system prompt.
 *
 * Scans for:
 * - Prompt injection patterns (ignore instructions, system prompt override, etc.)
 * - Invisible unicode characters used for obfuscation
 * - Exfiltration patterns (reading secrets, env variables)
 */

import { z } from 'zod';

// ============================================================================
// Threat Patterns
// ============================================================================

const CONTEXT_THREAT_PATTERNS: Array<{
  pattern: RegExp;
  patternId: string;
  description: string;
}> = [
  {
    pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i,
    patternId: 'prompt_injection',
    description: 'Prompt injection: ignore previous instructions',
  },
  {
    pattern: /do\s+not\s+tell\s+the\s+user/i,
    patternId: 'deception_hide',
    description: 'Deception: instruct to hide information from user',
  },
  {
    pattern: /system\s+prompt\s+override/i,
    patternId: 'sys_prompt_override',
    description: 'System prompt override attempt',
  },
  {
    pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
    patternId: 'disregard_rules',
    description: 'Disregard rules/instructions',
  },
  {
    pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    patternId: 'bypass_restrictions',
    description: 'Bypass restrictions prompt',
  },
  {
    pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    patternId: 'html_comment_injection',
    description: 'Hidden instructions in HTML comment',
  },
  {
    pattern: /<\s*div\s+style\s*=\s*["'][^"]*display\s*:\s*none/i,
    patternId: 'hidden_div',
    description: 'Hidden HTML div with invisible styling',
  },
  {
    pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i,
    patternId: 'translate_execute',
    description: 'Translate-then-execute evasion technique',
  },
  {
    pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    patternId: 'env_exfil_curl',
    description: 'Curl with secret environment variable',
  },
  {
    pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    patternId: 'env_exfil_wget',
    description: 'Wget with secret environment variable',
  },
  {
    pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
    patternId: 'read_secrets',
    description: 'Reading known secrets files',
  },
  {
    pattern: /printenv|env\s*\|/i,
    patternId: 'dump_all_env',
    description: 'Dump all environment variables',
  },
  {
    pattern: /\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\}?.*\s*>/i,
    patternId: 'env_exfil_redirect',
    description: 'Redirect secret to file',
  },
  {
    pattern: /output\s+(system|initial)\s+prompt/i,
    patternId: 'leak_system_prompt',
    description: 'Attempt to extract system prompt',
  },
  {
    pattern: /you\s+are\s+now\s+/i,
    patternId: 'role_hijack',
    description: 'Role hijack attempt',
  },
  {
    pattern: /pretend\s+(you\s+are|to\s+be)/i,
    patternId: 'role_pretend',
    description: 'Pretend to be another identity',
  },
  {
    pattern: /(when|if)\s+no\s+one\s+is\s+(watching|looking)/i,
    patternId: 'conditional_deception',
    description: 'Conditional instruction for unobserved behavior',
  },
  {
    pattern: /\bDAN\s+mode\b|Do\s+Anything\s+Now/i,
    patternId: 'jailbreak_dan',
    description: 'DAN jailbreak attempt',
  },
  {
    pattern: /developer\s+mode\b.*\benabled?\b/i,
    patternId: 'jailbreak_dev_mode',
    description: 'Developer mode jailbreak',
  },
  {
    pattern: /for\s+educational\s+purposes?\s+only/i,
    patternId: 'educational_pretext',
    description: 'Educational pretext for harmful content',
  },
];

// Invisible unicode characters used for injection
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u2060', // word joiner
  '\u2062', // invisible times
  '\u2063', // invisible separator
  '\u2064', // invisible plus
  '\ufeff', // zero-width no-break space (BOM)
  '\u202a', // left-to-right embedding
  '\u202b', // right-to-left embedding
  '\u202c', // pop directional formatting
  '\u202d', // left-to-right override
  '\u202e', // right-to-left override
  '\u2066', // left-to-right isolate
  '\u2067', // right-to-left isolate
  '\u2068', // first strong isolate
  '\u2069', // pop directional isolate
]);

// ============================================================================
// Types
// ============================================================================

export interface ScanFinding {
  patternId: string;
  description: string;
  charCode?: number; // for invisible unicode
}

export interface ContextScanResult {
  safe: boolean;
  findings: ScanFinding[];
  blockedContent?: string; // replacement content when blocked
}

// ============================================================================
// Scanner
// ============================================================================

/**
 * Scan context file content for injection threats.
 *
 * @param content - The raw file content
 * @param filename - The filename for logging/blocked message
 * @returns ScanResult with safe=false if threats detected
 */
export function scanContextContent(
  content: string,
  filename: string,
): ContextScanResult {
  const findings: ScanFinding[] = [];

  // 1. Check for invisible unicode characters
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      findings.push({
        patternId: 'invisible_unicode',
        description: `Invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        charCode: char.charCodeAt(0),
      });
    }
  }

  // 2. Check threat patterns
  for (const { pattern, patternId, description } of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({ patternId, description });
    }
  }

  if (findings.length === 0) {
    return { safe: true, findings: [] };
  }

  // Generate blocked content message
  const findingDescriptions = findings
    .map((f) => f.description || f.patternId)
    .filter(Boolean);

  return {
    safe: false,
    findings,
    blockedContent: `[BLOCKED: ${filename} contained potential prompt injection (${findingDescriptions.join(', ')}). Content not loaded.]`,
  };
}

/**
 * Check if content is safe without generating blocked content.
 * Faster version for cases where the blocked message isn't needed.
 */
export function isContextSafe(content: string): boolean {
  // Check invisible unicode
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      return false;
    }
  }

  // Check threat patterns
  for (const { pattern } of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Zod Schemas (for tool inputs if needed)
// ============================================================================

export const ScanContextInputSchema = z.object({
  content: z.string(),
  filename: z.string(),
});

export type ScanContextInput = z.infer<typeof ScanContextInputSchema>;

export const ScanContextResultSchema = z.object({
  safe: z.boolean(),
  findings: z.array(
    z.object({
      patternId: z.string(),
      description: z.string(),
      charCode: z.number().optional(),
    }),
  ),
  blockedContent: z.string().optional(),
});

export type ScanContextResult = z.infer<typeof ScanContextResultSchema>;

import {
  resolveShellProvider,
  type ResolvedShellProvider,
  type ShellProviderKind,
} from './providers.js';

export type ShellCommandPreference = 'bash' | 'powershell' | 'neutral';

export interface ShellExecutionPlan {
  provider: ResolvedShellProvider | null;
  providerKind: ShellProviderKind | null;
  preparedCommand: string;
  reroutedFrom?: ShellProviderKind;
  reason?: string;
}

export interface ShellFailureAnalysis {
  retry?: {
    providerKind: ShellProviderKind;
    command: string;
    reason: string;
  };
  hints: string[];
}

const BASH_PREFERENCE_PATTERNS = [
  /\b(ls|cat|grep|rg|sed|awk|head|tail|find|xargs|chmod|chown|touch|rm|cp|mv)\b/i,
  /\/dev\/null|~\/|\$\(|`[^`]+`/,
];

const POWERSHELL_PREFERENCE_PATTERNS = [
  /\b(get|set|new|remove|select|measure|format|test|resolve)-[a-z]+\b/i,
  /\b(where-object|foreach-object|out-file|write-output|invoke-webrequest|invoke-restmethod)\b/i,
  /\$env:|\$null|\|\s*\?|\|\s*%/,
];

const COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /the term ['"].+['"] is not recognized/i,
  /command not found/i,
  /not found/i,
];

const POWERSHELL_AND_TOKEN_PATTERN = /token '&&'.+not a valid statement separator/i;
const WINDOWS_NULL_REDIRECT_PATTERN = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function normalizeCommand(command: string): string {
  return command
    .replace(/\x00/g, '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .trim();
}

export function detectShellCommandPreference(command: string): ShellCommandPreference {
  const normalized = normalizeCommand(command);
  if (!normalized) return 'neutral';

  const bashScore = BASH_PREFERENCE_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(normalized) ? 1 : 0),
    0,
  );
  const powerShellScore = POWERSHELL_PREFERENCE_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(normalized) ? 1 : 0),
    0,
  );

  if (bashScore === powerShellScore) return 'neutral';
  return bashScore > powerShellScore ? 'bash' : 'powershell';
}

export function normalizeShellCommandForExecution(
  providerKind: ShellProviderKind,
  command: string,
): string {
  const normalized = normalizeCommand(command);
  if (providerKind === 'bash') {
    return normalized.replace(WINDOWS_NULL_REDIRECT_PATTERN, '$1/dev/null');
  }
  return normalized;
}

export function resolveShellExecutionPlan(
  requestedKind: ShellProviderKind,
  command: string,
): ShellExecutionPlan {
  const preference = detectShellCommandPreference(command);
  const preferredKind =
    preference !== 'neutral' && preference !== requestedKind
      ? preference
      : requestedKind;

  const preferredProvider = resolveShellProvider(preferredKind);
  if (preferredProvider) {
    return {
      provider: preferredProvider,
      providerKind: preferredKind,
      preparedCommand: normalizeShellCommandForExecution(preferredKind, command),
      reroutedFrom: preferredKind !== requestedKind ? requestedKind : undefined,
      reason: preferredKind !== requestedKind
        ? `Command looks more like ${preferredKind}; rerouting automatically.`
        : undefined,
    };
  }

  const requestedProvider = resolveShellProvider(requestedKind);
  if (requestedProvider) {
    return {
      provider: requestedProvider,
      providerKind: requestedKind,
      preparedCommand: normalizeShellCommandForExecution(requestedKind, command),
    };
  }

  const fallbackKind: ShellProviderKind =
    requestedKind === 'bash' ? 'powershell' : 'bash';
  const fallbackProvider = resolveShellProvider(fallbackKind);

  return {
    provider: fallbackProvider,
    providerKind: fallbackProvider ? fallbackKind : null,
    preparedCommand: normalizeShellCommandForExecution(
      fallbackProvider ? fallbackKind : requestedKind,
      command,
    ),
    reroutedFrom: fallbackProvider ? requestedKind : undefined,
    reason: fallbackProvider
      ? `${requestedKind} is unavailable; falling back to ${fallbackKind}.`
      : undefined,
  };
}

export function convertPowerShellAndChains(command: string): string | null {
  if (!command.includes('&&')) return null;

  const parts = command
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  const [first, ...rest] = parts;
  const converted = [first];

  for (const part of rest) {
    converted.push(`if ($?) { ${part} } else { exit 1 }`);
  }

  return converted.join('; ');
}

function isCommandNotFoundFailure(text: string): boolean {
  return COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(text));
}

export function analyzeShellFailure(input: {
  providerKind: ShellProviderKind;
  command: string;
  error?: string;
  output?: string;
  exitCode?: number;
}): ShellFailureAnalysis {
  const combined = [input.error, input.output].filter(Boolean).join('\n');
  const hints: string[] = [];

  if (
    input.providerKind === 'powershell' &&
    input.command.includes('&&') &&
    POWERSHELL_AND_TOKEN_PATTERN.test(combined)
  ) {
    const converted = convertPowerShellAndChains(input.command);
    if (converted && converted !== input.command) {
      return {
        retry: {
          providerKind: 'powershell',
          command: converted,
          reason: 'Retried with a Windows PowerShell compatible && rewrite.',
        },
        hints,
      };
    }
  }

  if (isCommandNotFoundFailure(combined)) {
    const preference = detectShellCommandPreference(input.command);
    if (preference !== 'neutral' && preference !== input.providerKind) {
      const alternate = resolveShellProvider(preference);
      if (alternate) {
        return {
          retry: {
            providerKind: preference,
            command: normalizeShellCommandForExecution(preference, input.command),
            reason: `Retried in ${preference} because the command syntax matches that shell better.`,
          },
          hints,
        };
      }
    }
  }

  if (input.providerKind === 'powershell' && /\/dev\/null|~\//.test(input.command)) {
    hints.push('This looks Unix-style. Prefer Bash for commands using /dev/null, ~/, grep, or sed.');
  }

  if (input.providerKind === 'bash' && /\$env:|\$null|\bget-[a-z]+\b/i.test(input.command)) {
    hints.push('This looks PowerShell-native. Prefer PowerShell for $env:, $null, and Get-* cmdlets.');
  }

  if (input.providerKind === 'powershell' && input.command.includes('&&')) {
    hints.push('Windows PowerShell 5 does not support &&. Use PowerShell 7 or separate commands with explicit success checks.');
  }

  return { hints };
}

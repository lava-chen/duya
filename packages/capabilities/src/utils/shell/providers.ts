import { Buffer } from 'node:buffer';
import type { ShellInfo } from '../shellDetector.js';
import { detectShellForFamily } from '../shellDetector.js';

export type ShellProviderKind = 'bash' | 'powershell';

export interface ResolvedShellProvider {
  kind: ShellProviderKind;
  shellInfo: ShellInfo;
  buildArgs(command: string): string[];
}

export function wrapPowerShellCommand(command: string): string {
  return [
    '$ProgressPreference = \'SilentlyContinue\'',
    '$InformationPreference = \'Continue\'',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = \'PlainText\' }',
    command,
  ].join('; ');
}

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

export function buildPowerShellArgs(command: string): string[] {
  const wrappedCommand = wrapPowerShellCommand(command);
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShellCommand(wrappedCommand),
  ];
}

/**
 * Prefix every unix-shell command with an extglob disable. Extended globs can
 * expand malicious filenames AFTER our security validation has already run
 * (the same post-validation expansion attack claude-code defends against).
 * bash exposes `shopt`; zsh (the fallback login shell on some Unix hosts)
 * needs `setopt` instead. Both probes are silenced so an unexpected fallback
 * shell adds no stderr noise, and the guard cannot change the command's exit
 * status because the user command runs last.
 */
export function buildExtglobGuard(shellName: string): string {
  if (shellName.toLowerCase().includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null';
  }
  return 'command -v shopt >/dev/null 2>&1 && shopt -u extglob';
}

function buildUnixShellArgs(shellInfo: ShellInfo, command: string): string[] {
  return [
    shellInfo.execArg,
    `${buildExtglobGuard(shellInfo.name)}; ${command}`,
  ];
}

export function resolveShellProvider(
  kind: ShellProviderKind,
): ResolvedShellProvider | null {
  if (kind === 'bash') {
    const shellInfo = detectShellForFamily('unix');
    if (!shellInfo) return null;
    return {
      kind,
      shellInfo,
      buildArgs: (command) => buildUnixShellArgs(shellInfo, command),
    };
  }

  const shellInfo = detectShellForFamily('powershell');
  if (!shellInfo) return null;

  return {
    kind,
    shellInfo,
    buildArgs: buildPowerShellArgs,
  };
}

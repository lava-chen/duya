import { Buffer } from 'node:buffer';
import type { ShellInfo } from '../shellDetector.js';
import { detectShellForFamily } from '../shellDetector.js';

export type ShellProviderKind = 'bash' | 'powershell';

export interface ResolvedShellProvider {
  kind: ShellProviderKind;
  shellInfo: ShellInfo;
  buildArgs(command: string): string[];
}

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

export function buildPowerShellArgs(command: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShellCommand(command),
  ];
}

function buildUnixShellArgs(shellInfo: ShellInfo, command: string): string[] {
  return [shellInfo.execArg, command];
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

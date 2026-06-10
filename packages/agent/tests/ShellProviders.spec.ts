import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  buildPowerShellArgs,
  encodePowerShellCommand,
  wrapPowerShellCommand,
} from '../src/utils/shell/providers.js';

describe('shell providers', () => {
  it('encodes powershell commands as UTF-16LE base64', () => {
    const command = "Write-Output 'hello'";
    const encoded = encodePowerShellCommand(command);
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');

    expect(decoded).toBe(command);
  });

  it('builds non-interactive powershell arguments with encoded command', () => {
    const command = 'Get-ChildItem';
    const args = buildPowerShellArgs(command);
    const decoded = Buffer.from(String(args[5]), 'base64').toString('utf16le');

    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(wrapPowerShellCommand(command)),
    ]);

    expect(decoded).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(decoded).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    expect(decoded).toContain('Get-ChildItem');
  });
});

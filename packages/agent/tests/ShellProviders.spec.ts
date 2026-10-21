import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  buildExtglobGuard,
  buildPowerShellArgs,
  encodePowerShellCommand,
  resolveShellProvider,
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

  describe('extglob guard', () => {
    it('disables extglob via shopt for bash shells', () => {
      const expected = 'command -v shopt >/dev/null 2>&1 && shopt -u extglob';
      expect(buildExtglobGuard('bash')).toBe(expected);
      expect(buildExtglobGuard('bash (Git Bash)')).toBe(expected);
      expect(buildExtglobGuard('/bin/bash')).toBe(expected);
    });

    it('disables extended globs via setopt for zsh', () => {
      expect(buildExtglobGuard('zsh')).toBe('setopt NO_EXTENDED_GLOB 2>/dev/null');
    });

    it('prefixes unix shell args with the guard and keeps the command intact', () => {
      const provider = resolveShellProvider('bash');
      if (!provider) {
        // No unix-family shell on this host; the guard itself is covered above.
        return;
      }

      const command = 'echo hello';
      const args = provider.buildArgs(command);

      expect(args[0]).toBe(provider.shellInfo.execArg);
      expect(args[1]?.endsWith(`; ${command}`)).toBe(true);
      // bash → shopt probe; zsh fallback → setopt. Either way the disable
      // must come before the user command.
      expect(args[1]).toMatch(/^(command -v shopt|setopt NO_EXTENDED_GLOB)/);
    });
  });
});

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildExtglobGuard,
  buildPowerShellArgs,
  encodePowerShellCommand,
  resolveShellProvider,
  wrapPowerShellCommand,
} from '../../src/utils/shell/providers.js';
import { detectShell, detectShellForFamily } from '../../src/utils/shellDetector.js';

describe('shell capability', () => {
  const executionProvider = resolveShellProvider(process.platform === 'win32' ? 'powershell' : 'bash');

  it('detects a usable default shell on the current platform', () => {
    const shell = detectShell();
    expect(shell.path.length).toBeGreaterThan(0);
    expect(shell.execArg.length).toBeGreaterThan(0);
    expect(['unix', 'powershell', 'cmd']).toContain(shell.family);
  });

  it.skipIf(executionProvider === null)('builds and runs commands through the resolved provider', () => {
    expect(buildExtglobGuard('zsh')).toContain('NO_EXTENDED_GLOB');
    expect(buildExtglobGuard('bash')).toContain('shopt -u extglob');

    if (!executionProvider) throw new Error('The test is not skipped when its shell provider is absent');
    const command = executionProvider.kind === 'powershell'
      ? 'Write-Output capability-shell-ok'
      : 'printf capability-shell-ok';
    const output = execFileSync(executionProvider.shellInfo.path, executionProvider.buildArgs(command), {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    // The resolved shell terminates its output record with the platform line
    // ending (PowerShell writes CRLF on Windows, POSIX printf writes none).
    // The capability trims that terminator before the model sees it
    // (truncateShellOutput), so compare the payload with at most one trailing
    // terminator removed — a blanket trim() would also hide stray whitespace.
    const payload = output.replace(/(?:\r\n|\r|\n)$/, '');
    expect(payload).toBe('capability-shell-ok');
    expect(output).toMatch(/^capability-shell-ok(?:\r\n|\r|\n)?$/);
  });

  it('keeps PowerShell commands encoded as UTF-16LE and non-interactive', () => {
    const command = 'Write-Output "能力正常"';
    const decoded = Buffer.from(encodePowerShellCommand(command), 'base64').toString('utf16le');
    expect(decoded).toBe(command);

    const args = buildPowerShellArgs(command);
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(Buffer.from(args[5] ?? '', 'base64').toString('utf16le')).toContain(command);
    expect(wrapPowerShellCommand(command)).toContain('[Console]::OutputEncoding');
  });

  it('returns a resolved provider only when the requested family is available', () => {
    expect(detectShellForFamily('unix') === null || detectShellForFamily('unix')?.family === 'unix').toBe(true);
    expect(detectShellForFamily('powershell') === null || detectShellForFamily('powershell')?.family === 'powershell').toBe(true);
  });
});

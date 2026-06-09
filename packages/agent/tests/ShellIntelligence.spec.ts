import { describe, expect, it } from 'vitest';
import {
  analyzeShellFailure,
  convertPowerShellAndChains,
  detectShellCommandPreference,
  normalizeShellCommandForExecution,
} from '../src/utils/shell/intelligence.js';

describe('shell intelligence', () => {
  it('detects strong shell preferences from command syntax', () => {
    expect(detectShellCommandPreference('Get-ChildItem Env:')).toBe('powershell');
    expect(detectShellCommandPreference('ls -la | grep src')).toBe('bash');
    expect(detectShellCommandPreference('git status')).toBe('neutral');
  });

  it('normalizes bash-specific Windows null redirects safely', () => {
    expect(normalizeShellCommandForExecution('bash', 'ls 2>nul')).toBe('ls 2>/dev/null');
    expect(normalizeShellCommandForExecution('powershell', 'Get-ChildItem')).toBe('Get-ChildItem');
  });

  it('rewrites PowerShell && chains for Windows PowerShell compatibility', () => {
    expect(convertPowerShellAndChains('python --version && where.exe python')).toBe(
      'python --version; if ($?) { where.exe python } else { exit 1 }',
    );
  });

  it('offers a safe retry when PowerShell 5 rejects && separators', () => {
    const analysis = analyzeShellFailure({
      providerKind: 'powershell',
      command: 'python --version && where.exe python',
      error: "The token '&&' is not a valid statement separator in this version.",
      output: '',
      exitCode: 1,
    });

    expect(analysis.retry).toBeDefined();
    expect(analysis.retry?.providerKind).toBe('powershell');
    expect(analysis.retry?.command).toContain('if ($?)');
  });

  it('adds hints when a PowerShell command is sent to bash', () => {
    const analysis = analyzeShellFailure({
      providerKind: 'bash',
      command: '$env:FOO; Get-ChildItem',
      error: 'command not found',
      output: '',
      exitCode: 127,
    });

    expect(analysis.retry?.providerKind).toBe('powershell');
  });
});

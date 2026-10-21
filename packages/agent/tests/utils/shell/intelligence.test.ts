import { describe, it, expect } from 'vitest';
import { normalizeShellCommandForExecution } from '../../../src/utils/shell/intelligence.js';

describe('normalizeShellCommandForExecution', () => {
  describe('bash provider', () => {
    it('converts Windows NUL redirect to /dev/null', () => {
      const result = normalizeShellCommandForExecution('bash', 'cmd > NUL');
      expect(result).toBe('cmd > /dev/null');
    });

    it('leaves Unix redirect unchanged', () => {
      const result = normalizeShellCommandForExecution('bash', 'cmd 2>/dev/null');
      expect(result).toBe('cmd 2>/dev/null');
    });
  });

  describe('powershell provider', () => {
    it('converts stderr /dev/null redirect', () => {
      const result = normalizeShellCommandForExecution('powershell', 'ls "path" 2>/dev/null');
      expect(result).toBe('ls "path" 2>$null');
    });

    it('converts stdout /dev/null redirect', () => {
      const result = normalizeShellCommandForExecution('powershell', 'cmd > /dev/null');
      expect(result).toBe('cmd >$null');
    });

    it('converts combined /dev/null redirect', () => {
      const result = normalizeShellCommandForExecution('powershell', 'cmd > /dev/null 2>&1');
      expect(result).toBe('cmd *>$null');
    });

    it('converts head pipe with count', () => {
      const result = normalizeShellCommandForExecution('powershell', 'ls "path" | head -30');
      expect(result).toBe('ls "path" | Select-Object -First 30');
    });

    it('converts head pipe with -n', () => {
      const result = normalizeShellCommandForExecution('powershell', 'cat log | head -n 5');
      expect(result).toBe('cat log | Select-Object -First 5');
    });

    it('converts bare head pipe', () => {
      const result = normalizeShellCommandForExecution('powershell', 'cat log | head');
      expect(result).toBe('cat log | Select-Object -First 10');
    });

    it('converts tail pipe', () => {
      const result = normalizeShellCommandForExecution('powershell', 'cat log | tail -n 5');
      expect(result).toBe('cat log | Select-Object -Last 5');
    });

    it('converts ls -la', () => {
      const result = normalizeShellCommandForExecution('powershell', 'ls -la "path"');
      expect(result).toBe('Get-ChildItem -Force "path"');
    });

    it('converts the directory listing command from the Windows false-empty screenshot', () => {
      const result = normalizeShellCommandForExecution(
        'powershell',
        'ls -la "C:/Users/lavachen/.duya/memory/rollout_summaries/" 2>/dev/null | head -30',
      );
      expect(result).toBe(
        'Get-ChildItem -Force "C:/Users/lavachen/.duya/memory/rollout_summaries/" 2>$null | Select-Object -First 30',
      );
    });

    it('leaves PowerShell-native syntax untouched', () => {
      const result = normalizeShellCommandForExecution(
        'powershell',
        'Get-ChildItem | Select-Object -First 10',
      );
      expect(result).toBe('Get-ChildItem | Select-Object -First 10');
    });
  });
});

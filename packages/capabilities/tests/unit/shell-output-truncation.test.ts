import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASH_MAX_OUTPUT_CHARS,
  BASH_MAX_OUTPUT_LINES,
  truncateShellOutput,
} from '../../src/ShellCommandTool/BashTool.js';

const markerOverhead = 400;

describe('truncateShellOutput', () => {
  it('returns output that fits both budgets untouched', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    expect(truncateShellOutput(content).output).toBe(content);
  });

  it('keeps both ends and drops the middle', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'p'.repeat(60)}`);
    const { output } = truncateShellOutput(lines.join('\n'));

    expect(output).toContain('line 0 ');
    expect(output).toContain('line 1999 ');
    expect(output).not.toContain('line 1000 ');
    expect(output).toContain('Output truncated: kept first');
  });

  it('enforces the line budget even when the character budget is not binding', () => {
    // 1,001 one-character lines: over the line limit, far under the char limit.
    const lines = Array.from({ length: BASH_MAX_OUTPUT_LINES + 1 }, (_, i) => String(i % 10));
    const { output } = truncateShellOutput(lines.join('\n'));

    expect(output).toContain(
      `kept first ${BASH_MAX_OUTPUT_LINES / 2} and last ${BASH_MAX_OUTPUT_LINES / 2} `
      + `of ${(BASH_MAX_OUTPUT_LINES + 1).toLocaleString()} lines`,
    );
    const keptContent = output.slice(0, output.indexOf('\n\n[Output truncated'));
    expect(keptContent.split('\n')).toHaveLength(BASH_MAX_OUTPUT_LINES);
  });

  it('caps a single oversized line instead of passing it through whole', () => {
    // A `\r` progress bar arrives as one line with no newline at all.
    const { output } = truncateShellOutput('x'.repeat(100_000));
    expect(output.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_CHARS + markerOverhead);
  });

  it('never exceeds the character budget by more than the marker', () => {
    const mixed = Array.from({ length: 400 }, (_, i) => `${i}`.padEnd(20_000, 'x'));
    const { output } = truncateShellOutput(mixed.join('\n'));
    expect(output.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_CHARS + markerOverhead);
  });

  it('spills the full output to disk and points the model at it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'duya-bash-truncate-'));
    try {
      const content = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n');
      const { output, fullOutputPath } = truncateShellOutput(content, directory);

      expect(fullOutputPath).toBeTruthy();
      expect(output).toContain(fullOutputPath as string);
      expect(readFileSync(fullOutputPath as string, 'utf8')).toBe(content);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

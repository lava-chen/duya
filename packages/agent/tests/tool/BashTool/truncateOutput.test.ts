import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  BASH_MAX_OUTPUT_CHARS,
  BASH_MAX_OUTPUT_LINES,
  truncateShellOutput,
} from '../../../src/tool/BashTool/BashTool';

describe('truncateShellOutput', () => {
  it('returns the trimmed content unchanged when within limits', () => {
    const output = '  hello world\nsecond line  \n';
    const result = truncateShellOutput(output);
    expect(result.output).toBe('hello world\nsecond line');
    expect(result.fullOutputPath).toBeUndefined();
  });

  it('truncates a very long single-line output to the char tail and spills the full output', () => {
    const big = 'x'.repeat(500_000);
    const result = truncateShellOutput(big);

    expect(result.output.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_CHARS + 500);
    expect(result.output).toContain('[Output truncated:');
    expect(result.output).toContain('Full output saved to:');
    expect(result.fullOutputPath).toBeDefined();
    // The full output must be on disk, byte-identical.
    expect(fs.readFileSync(result.fullOutputPath!, 'utf8')).toBe(big);
    fs.rmSync(result.fullOutputPath!, { force: true });
  });

  it('truncates when the line count exceeds the limit', () => {
    const manyLines = Array.from({ length: BASH_MAX_OUTPUT_LINES + 50 }, (_, i) => `line-${i}`).join('\n');
    const result = truncateShellOutput(manyLines);

    expect(result.output).toContain('[Output truncated:');
    expect(result.fullOutputPath).toBeDefined();
    fs.rmSync(result.fullOutputPath!, { force: true });
  });

  it('returns the marker with a readable tail even for a huge blob', () => {
    const head = 'AAAHEAD\n';
    const tailParts = ['END', 'RESULT', 'exit code 0'];
    const big = head + 'y'.repeat(800_000) + '\n' + tailParts.join('\n');
    const result = truncateShellOutput(big);

    // The useful tail (final result lines) must survive truncation.
    for (const part of tailParts) {
      expect(result.output).toContain(part);
    }
    fs.rmSync(result.fullOutputPath!, { force: true });
  });
});
/**
 * The per-tool render layer: grouping families and result formatting.
 *
 * Two halves, both pinned here:
 *
 *  - the DECISION functions (`toolGroupKey`, `isShellTool`, `shellCommandOf`,
 *    `selectShellOutput`, `formatToolResult`) as pure functions, and
 *  - the rendered result through the real `TranscriptModel` + `renderTranscript`,
 *    because the value of the layer is what reaches the screen, not what the
 *    helper returns.
 *
 * `strip` removes blessed tags so an assertion can quote the text the reader
 * sees (`$ npm test`) instead of the tagged form the renderer emits.
 */

import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import {
  formatToolResult,
  isShellTool,
  selectShellOutput,
  shellCommandOf,
  toolGroupKey,
} from '../tool-render.js';
import { DEFAULT_RENDER_OPTIONS, renderTranscript } from '../transcript-view.js';

/** Strip blessed tags, leaving the text a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

describe('toolGroupKey', () => {
  it('groups the exploration family across names', () => {
    expect(toolGroupKey('read')).toBe('explore');
    expect(toolGroupKey('glob')).toBe('explore');
    expect(toolGroupKey('grep')).toBe('explore');
  });

  it('groups the legacy exploration names with the real ones', () => {
    expect(toolGroupKey('read_file')).toBe('explore');
    expect(toolGroupKey('search_files')).toBe('explore');
  });

  it('groups the shell family across names', () => {
    expect(toolGroupKey('bash')).toBe('shell');
    expect(toolGroupKey('powershell')).toBe('shell');
    expect(toolGroupKey('terminal')).toBe('shell');
  });

  it('keys every other tool by its own name', () => {
    expect(toolGroupKey('edit')).toBe('edit');
    expect(toolGroupKey('write')).toBe('write');
    expect(toolGroupKey('task')).toBe('task');
  });
});

describe('isShellTool / shellCommandOf', () => {
  it('recognises shell tools', () => {
    expect(isShellTool('bash')).toBe(true);
    expect(isShellTool('powershell')).toBe(true);
    expect(isShellTool('read')).toBe(false);
  });

  it('extracts an unclipped command', () => {
    expect(shellCommandOf({ command: 'npm test' })).toBe('npm test');
    // No clipping: the body's evidence line must show what actually ran.
    const long = `echo ${'x'.repeat(200)}`;
    expect(shellCommandOf({ command: long })).toBe(long);
  });

  it('returns undefined when there is no command', () => {
    expect(shellCommandOf({})).toBeUndefined();
    expect(shellCommandOf({ command: '   ' })).toBeUndefined();
    expect(shellCommandOf({ command: 42 })).toBeUndefined();
    expect(shellCommandOf(null)).toBeUndefined();
    expect(shellCommandOf('npm test')).toBeUndefined();
  });
});

describe('selectShellOutput', () => {
  it('shows everything when the output fits the budget', () => {
    expect(selectShellOutput('a\nb', 'ok', 5)).toEqual(['a', 'b']);
  });

  it('keeps head and tail of a successful run', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const chosen = selectShellOutput(lines.join('\n'), 'ok', 3);
    expect(chosen[0]).toBe('line 0');
    expect(chosen[1]).toBe('line 1');
    expect(chosen).toContain('… 37 lines hidden');
    expect(chosen[chosen.length - 1]).toBe('line 39');
  });

  it('keeps the tail of a failure and pins the exit code above it', () => {
    const body = Array.from({ length: 12 }, (_, i) => `err ${i}`);
    const chosen = selectShellOutput(['[Exit code: 2]', ...body].join('\n'), 'error', 8);
    // The exit code survives even though a tail selection would drop it.
    expect(chosen[0]).toBe('[Exit code: 2]');
    expect(chosen[1]).toBe('… 4 earlier lines hidden');
    expect(chosen).toContain('err 11');
    expect(chosen).not.toContain('err 0');
  });

  it('reports empty output rather than rendering nothing', () => {
    expect(selectShellOutput('', 'ok', 5)).toEqual(['(no output)']);
  });
});

const GREP_REPORT = JSON.stringify({
  success: true,
  matches: [
    { file: 'src/a.ts', line: 12, column: 3, content: 'const useStreaming = true' },
    { file: 'src/b.ts', line: 4, column: 1, content: 'useStreaming()' },
  ],
  total: 2,
  truncated: false,
  searchPath: '.',
  engine: 'ripgrep',
});

describe('formatToolResult', () => {
  it('renders a grep report as a summary plus path:line rows', () => {
    const formatted = formatToolResult('grep', GREP_REPORT);
    expect(formatted).toBe(
      ['2 matches found', 'src/a.ts:12  const useStreaming = true', 'src/b.ts:4  useStreaming()'].join('\n'),
    );
  });

  it('prefers the true total over the returned match count', () => {
    const report = JSON.stringify({
      success: true,
      matches: [{ file: 'a.ts', line: 1, column: 1, content: 'x' }],
      total: 90,
      truncated: true,
    });
    expect(formatToolResult('grep', report)).toContain('90 matches found (truncated)');
  });

  it('renders a grep failure as one error line', () => {
    const report = JSON.stringify({ success: false, error: 'pattern is not a valid regex' });
    expect(formatToolResult('grep', report)).toBe('error: pattern is not a valid regex');
  });

  it('passes through anything that is not a report', () => {
    expect(formatToolResult('grep', 'No files matched')).toBe('No files matched');
    expect(formatToolResult('read', GREP_REPORT)).toBe(GREP_REPORT);
    expect(formatToolResult('bash', 'raw output')).toBe('raw output');
  });

  it('collapses the padding line of a glob report', () => {
    const result = '2 files matched\n\nsrc/a.ts\nsrc/b.ts';
    expect(formatToolResult('glob', result)).toBe('2 files matched\nsrc/a.ts\nsrc/b.ts');
  });

  it('renders a glob failure as one error line', () => {
    const report = JSON.stringify({ success: false, error: 'outside the allowed roots' });
    expect(formatToolResult('glob', report)).toBe('error: outside the allowed roots');
  });
});

describe('rendered transcript', () => {
  it('shows a grep result as prose, not JSON', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'g1', name: 'grep', input: { pattern: 'useStreaming', path: 'src/' } } });
    model.apply({ type: 'tool_result', data: { id: 'g1', result: GREP_REPORT } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    expect(rendered).toContain('2 matches found');
    expect(rendered).toContain('src/a.ts:12');
    expect(rendered).not.toContain('"matches"');
  });

  it('groups consecutive exploration calls under one head', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 't1', name: 'glob', input: { pattern: '**/*.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 't1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 't2', name: 'read', input: { path: 'src/a.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 't2', result: 'ok' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // One head for the family, and the continuation names its own tool because
    // the head's name no longer describes it.
    expect(rendered.match(/glob\(/gu)).toHaveLength(1);
    expect(rendered).toContain('└ read src/a.ts');
  });

  it('names a same-family continuation when the tool differs', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 's1', name: 'bash', input: { command: 'a' } } });
    model.apply({ type: 'tool_result', data: { id: 's1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 's2', name: 'powershell', input: { command: 'b' } } });
    model.apply({ type: 'tool_result', data: { id: 's2', result: 'ok' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    expect(rendered).toContain('└ powershell b');
  });

  it('renders a shell result with a command evidence line and the output', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'b1', name: 'bash', input: { command: 'npm test' } } });
    model.apply({ type: 'tool_result', data: { id: 'b1', result: 'pass 1\npass 2\npass 3\nfail 4' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // `$ ` prefixes the evidence line; the head carries the bare bash(...)
    // label, so the command text appears exactly once in this form.
    expect(rendered.match(/\$ npm test/gu)).toHaveLength(1);
    expect(rendered).toContain('fail 4');
  });

  it('labels a shell result with an output-line count when details are hidden', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'b3', name: 'bash', input: { command: 'npm test' } } });
    model.apply({ type: 'tool_result', data: { id: 'b3', result: 'pass 1\npass 2\npass 3\nfail 4' } });
    const rendered = strip(renderTranscript(model, { ...DEFAULT_RENDER_OPTIONS, showToolResults: false }));
    expect(rendered).toContain('[+ 4 output lines]');
    expect(rendered).not.toContain('fail 4');
  });

  it('pins the exit code of a failed command in the body', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'b2', name: 'bash', input: { command: 'make' } } });
    model.apply({
      type: 'tool_result',
      // `error` belongs INSIDE `data`: the frame-level field is not read by the
      // model, and a failure that lands as `ok` gets the wrong output selection.
      data: {
        id: 'b2',
        result: ['[Exit code: 2]', ...Array.from({ length: 12 }, (_, i) => `err ${i}`)].join('\n'),
        error: true,
      },
    });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    expect(rendered).toContain('[Exit code: 2]');
    expect(rendered).toContain('err 11');
    // The head of the log is NOT shown — a failure's story is at the tail.
    expect(rendered).not.toContain('err 0\n');
    expect(strip(renderTranscript(model, { ...DEFAULT_RENDER_OPTIONS, showToolResults: false })))
      .toContain('[+ 13 output lines]');
  });
});

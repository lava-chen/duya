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
  isLocalShellTool,
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

  it('keeps the commands the user ran in a family of their own', () => {
    // A local command never folds into the agent's shell batch: "Ran 2
    // commands" must mean two commands the AGENT ran.
    expect(toolGroupKey('local_shell')).toBe('user-shell');
    expect(toolGroupKey('bash')).toBe('shell');
  });
});

describe('isShellTool / shellCommandOf', () => {
  it('recognises shell tools', () => {
    expect(isShellTool('bash')).toBe(true);
    expect(isShellTool('powershell')).toBe(true);
    expect(isShellTool('read')).toBe(false);
  });

  it('tells the user\'s own commands apart from the agent\'s', () => {
    expect(isLocalShellTool('local_shell')).toBe(true);
    expect(isLocalShellTool('bash')).toBe(false);
    // The body renderer is shared: a local command is a shell command too.
    expect(isShellTool('local_shell')).toBe(true);
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

  it('summarises a batch under one header instead of a head and continuations', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 't1', name: 'glob', input: { pattern: '**/*.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 't1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 't2', name: 'read', input: { path: 'src/a.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 't2', result: 'ok' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // The header carries the verb and the count; every call below it is an
    // equal child row showing its target, never a parent/child pair. A glob
    // plus a read is a MIXED pass, so the verb is `Explored`, not `Read`.
    expect(rendered).toContain('Explored 2 operations');
    expect(rendered).toContain('├ **/*.ts');
    expect(rendered).toContain('└ src/a.ts');
  });

  it('names a shell batch by what it did rather than by one of its tools', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 's1', name: 'bash', input: { command: 'a' } } });
    model.apply({ type: 'tool_result', data: { id: 's1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 's2', name: 'powershell', input: { command: 'b' } } });
    model.apply({ type: 'tool_result', data: { id: 's2', result: 'ok' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    expect(rendered).toContain('Ran 2 commands');
    expect(rendered).toContain('├ a');
    expect(rendered).toContain('└ b');
  });

  it('separates stanzas with one blank row and keeps a batch tight', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 's1', name: 'bash', input: { command: 'a' } } });
    model.apply({ type: 'tool_result', data: { id: 's1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 's2', name: 'bash', input: { command: 'b' } } });
    model.apply({ type: 'tool_result', data: { id: 's2', result: 'ok' } });
    model.addNotice('done');
    const lines = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS)).split('\n');
    // No blank inside the batch, exactly one before the notice.
    expect(lines.filter((line) => line === '')).toHaveLength(1);
    expect(lines.indexOf('')).toBe(lines.length - 2);
  });

  it('puts every body two columns right of its own row text', () => {
    const model = new TranscriptModel();
    model.upsertTool('a', 'read', { path: 'a.ts' });
    model.completeTool('a', 'A', false);
    model.upsertTool('b', 'read', { path: 'b.ts' });
    model.completeTool('b', 'B', false);
    const lines = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS)).split('\n');
    // The grid, pinned: connector at 0, its marker at 2, row text at 4, and a
    // BODY always two columns right of the text it belongs to (col 6 here,
    // col 4 under a standalone call). This is the rule the old mix of head and
    // `└` continuation rows broke — a continuation's body sat flush with its
    // own label while a head's body was indented.
    expect(lines).toEqual([
      '└ ✔ Read 2 files',
      '  ├ a.ts [-]',
      '  │   A',
      '  └ b.ts [-]',
      '      B',
    ]);
  });

  it('does not repeat a command the label already shows in full', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'b1', name: 'bash', input: { command: 'npm test' } } });
    model.apply({ type: 'tool_result', data: { id: 'b1', result: 'pass 1\npass 2\npass 3\nfail 4' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // `bash(npm test)` IS the evidence line when nothing was clipped; printing
    // `$ npm test` again under it was the same string twice.
    expect(rendered).toContain('bash(npm test)');
    expect(rendered).not.toContain('$ npm test');
    expect(rendered).toContain('fail 4');
  });

  it('repeats a clipped command on its own evidence line', () => {
    const command = 'find . -name "*.ts" -not -path "*/node_modules/*" | xargs wc -l | sort -n';
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'b4', name: 'bash', input: { command } } });
    model.apply({ type: 'tool_result', data: { id: 'b4', result: 'ok' } });
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // The row preview is clipped to one line, so the body is the only place
    // the whole command survives.
    expect(rendered).toContain(`$ ${command}`);
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

  it('gives the command the user ran a card of its own', () => {
    const model = new TranscriptModel();
    model.upsertTool('local-shell:1', 'local_shell', { command: 'git status' });
    model.completeTool('local-shell:1', 'on branch main', false);
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // "You ran", not "Ran": the reader must not have to guess whose command
    // produced the output.
    expect(rendered).toContain('You ran git status');
    expect(rendered).not.toContain('local_shell(');
  });

  it('keeps the user\'s command out of the agent\'s shell batch', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 's1', name: 'bash', input: { command: 'a' } } });
    model.apply({ type: 'tool_result', data: { id: 's1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 's2', name: 'bash', input: { command: 'b' } } });
    model.apply({ type: 'tool_result', data: { id: 's2', result: 'ok' } });
    model.upsertTool('local-shell:1', 'local_shell', { command: 'git status' });
    model.completeTool('local-shell:1', 'on branch main', false);
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    expect(rendered).toContain('Ran 2 commands');
    expect(rendered).toContain('You ran git status');
  });

  it('gives the command the user ran a far bigger output budget', () => {
    const model = new TranscriptModel();
    model.upsertTool('local-shell:1', 'local_shell', { command: 'ls' });
    model.completeTool('local-shell:1', Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'), false);
    const rendered = strip(renderTranscript(model, DEFAULT_RENDER_OPTIONS));
    // Fifty lines, where an agent call gets five: the output is what the user
    // asked for.
    expect(rendered).toContain('line 48');
    expect(rendered).toContain('… 10 lines hidden');
    expect(rendered).not.toContain('line 50');
  });
});

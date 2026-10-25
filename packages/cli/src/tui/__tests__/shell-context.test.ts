import { describe, expect, it } from 'vitest';
import {
  appendShellContext,
  shellContextAttachment,
  shellContextEntry,
  SHELL_CONTEXT_LIMIT,
} from '../shell-context.js';

describe('shellContextEntry', () => {
  it('formats the command, working directory and body', () => {
    expect(shellContextEntry('git status', '/repo', 'output here')).toBe(
      '$ git status\nWorking directory: /repo\noutput here',
    );
  });
});

describe('appendShellContext', () => {
  it('accumulates entries with a blank line between them', () => {
    const first = appendShellContext(null, 'one');
    expect(appendShellContext(first, 'two')).toBe('one\n\ntwo');
  });

  it('keeps the tail and marks the truncation when over the limit', () => {
    const big = 'x'.repeat(SHELL_CONTEXT_LIMIT + 10);
    const combined = appendShellContext(null, big);
    expect(combined.startsWith('[Earlier command context truncated]\n')).toBe(true);
    expect(combined.length).toBeLessThanOrEqual(SHELL_CONTEXT_LIMIT + '[Earlier command context truncated]\n'.length);
  });
});

describe('shellContextAttachment', () => {
  it('builds the terminal-ref attachment the worker pipeline reads', () => {
    const attachment = shellContextAttachment('$ git status\nok', 'git status', 7);
    expect(attachment).toEqual({
      id: 'terminal-ref-7',
      kind: 'terminal-ref',
      name: '$ git status',
      type: 'text/plain',
      url: '',
      size: '$ git status\nok'.length,
      text: '$ git status\nok',
    });
  });

  it('clips a long command in the name', () => {
    const attachment = shellContextAttachment('ctx', 'x'.repeat(200), 1);
    expect(attachment.name).toBe(`$ ${'x'.repeat(98)}`);
  });
});

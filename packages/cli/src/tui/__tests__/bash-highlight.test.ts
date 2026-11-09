import { describe, expect, it } from 'vitest';
import { highlightBash, highlightBashLine, type BashToken } from '../bash-highlight.js';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript } from '../transcript-view.js';

/** The role each token carries, as `role:text` pairs. */
function roles(line: string): string[] {
  return highlightBashLine(line).map((token) => `${token.role}:${token.text}`);
}

function tokenText(tokens: readonly BashToken[]): string {
  return tokens.map((token) => token.text).join('');
}

describe('bash highlighting', () => {
  it('names the program, its flags and its quoting', () => {
    expect(roles("git log --oneline -3 && echo 'done'")).toEqual([
      'program:git',
      'plain: log ',
      'flag:--oneline',
      'plain: ',
      'flag:-3',
      'plain: ',
      'operator:&&',
      'plain: ',
      'program:echo',
      'plain: ',
      "string:'done'",
    ]);
  });

  it('keeps the next word in command position after a pipe or a semicolon', () => {
    expect(roles('cat a.txt | head -5; wc -l')).toEqual([
      'program:cat',
      'plain: a.txt ',
      'operator:|',
      'plain: ',
      'program:head',
      'plain: ',
      'flag:-5',
      'operator:;',
      'plain: ',
      'program:wc',
      'plain: ',
      'flag:-l',
    ]);
  });

  it('does not mistake a prefix or an assignment for the program', () => {
    const prefixed = highlightBashLine('sudo git status');
    expect(prefixed[0]).toEqual({ text: 'sudo ', role: 'plain' });
    expect(prefixed[1]).toEqual({ text: 'git', role: 'program' });

    const assigned = highlightBashLine('FOO=1 npm run build');
    expect(assigned[0]).toEqual({ text: 'FOO=1 ', role: 'plain' });
    expect(assigned[1]).toEqual({ text: 'npm', role: 'program' });
  });

  it('colours expansions and comments', () => {
    expect(roles('echo "$HOME" ${PATH} $1 # trailing')).toEqual([
      'program:echo',
      'plain: ',
      'string:"$HOME"',
      'plain: ',
      'variable:${PATH}',
      'plain: ',
      'variable:$1',
      'plain: ',
      'comment:# trailing',
    ]);
  });

  it('reads a redirect as one operator', () => {
    expect(roles('node x.js 2>&1 >> out.log')).toEqual([
      'program:node',
      'plain: x.js ',
      'operator:2>&1',
      'plain: ',
      'operator:>>',
      'plain: out.log',
    ]);
  });

  it('never loses a character, including on input a shell would reject', () => {
    const cases = [
      '',
      '   ',
      "echo 'unclosed",
      'echo "unclosed',
      'echo ${unclosed',
      'a|b&&c;d',
      'cmd --flag=value',
      '#',
      'echo $',
      'if [ -f x ]; then rm x; fi',
    ];
    for (const line of cases) {
      expect(tokenText(highlightBashLine(line))).toBe(line);
    }
  });

  it('splits a multi-line command into one token list per line', () => {
    const lines = highlightBash('npm ci\nnpm test');
    expect(lines).toHaveLength(2);
    expect(lines.map((tokens) => tokens[0]?.text)).toEqual(['npm', 'npm']);
  });
});

describe('shell cells in the transcript', () => {
  const OPTIONS = { expanded: true, showToolResults: true, toolResultLines: 8 };

  it('paints the command by role instead of one flat grey', () => {
    const model = new TranscriptModel();
    model.upsertTool('c1', 'bash', { command: 'git log --oneline' });
    model.completeTool('c1', 'ok', false);

    const rendered = renderTranscript(model, OPTIONS);
    // The program is bold and accent-coloured; the flag is the warning colour.
    expect(rendered).toContain('{bold}{cyan-fg}git{/cyan-fg}{/bold}');
    expect(rendered).toContain('{yellow-fg}--oneline{/yellow-fg}');
    // The command is no longer one muted run.
    expect(rendered).not.toContain('{gray-fg}git log --oneline{/gray-fg}');
  });

  it('gives a failure exit code the error colour, not the body colour', () => {
    const model = new TranscriptModel();
    model.upsertTool('c1', 'bash', { command: 'npm test' });
    model.completeTool('c1', '[Exit code: 1]\nboom', true);

    const rendered = renderTranscript(model, OPTIONS);
    expect(rendered).toContain('{bright-red-fg}[Exit code: 1]{/bright-red-fg}');
    expect(rendered).toContain('{gray-fg}boom{/gray-fg}');
  });
});

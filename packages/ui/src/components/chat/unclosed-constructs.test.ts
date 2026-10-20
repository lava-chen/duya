import { describe, expect, it } from 'vitest';
import { preprocessUnclosedConstructs } from '@/lib/unclosed-constructs';

describe('preprocessUnclosedConstructs — math boundary normalization', () => {
  it('splits `$$` off the end of a prose line so the block becomes display math', () => {
    // The exact failure case from the screenshot:
    //   `## 1.公式$$\n<formula>\n$$`
    // The leading `$$` is glued to `1.公式`, so remark-math parses it as
    // inline math (single-line), rendering the multi-line formula as raw
    // source. Split into a standalone line so it becomes block-level math.
    const input = '## 1.公式$$\n\\text{loss}_{\\pi} = -\\sum_a \\pi^{\\text{target}}(a \\mid s) \\cdot \\log \\pi^{\\text{pred}}(a \\mid s)\n$$\n';
    const out = preprocessUnclosedConstructs(input);
    // The leading $$ should be on its own line, no longer glued.
    expect(out).toContain('## 1.公式\n$$');
    expect(out).toContain('\n$$\n');
  });

  it('inserts a blank line before a leading $$ so it does not merge with prose', () => {
    const input = 'Here is the formula.\n$$\nL = x^2\n$$\n';
    const out = preprocessUnclosedConstructs(input);
    expect(out).toContain('Here is the formula.\n\n$$\nL = x^2');
  });

  it('preserves a properly formatted standalone $$ block', () => {
    const input = '$$\nL = x^2\n$$\n';
    expect(preprocessUnclosedConstructs(input)).toBe(input);
  });

  it('handles $$ block with no preceding blank line followed by more text', () => {
    const input = 'intro\n$$\nmath\n$$\nafter';
    const out = preprocessUnclosedConstructs(input);
    expect(out).toContain('intro\n\n$$\nmath\n$$');
    expect(out).toContain('after');
  });
});

describe('preprocessUnclosedConstructs — unclosed math / code', () => {
  it('closes an unclosed $$ block at end of text', () => {
    expect(preprocessUnclosedConstructs('$$\nL = x^2')).toBe('$$\nL = x^2\n$$');
  });

  it('closes an unclosed inline $ block', () => {
    expect(preprocessUnclosedConstructs('The value is $x_2')).toBe('The value is $x_2$');
  });

  it('does nothing when math is balanced', () => {
    expect(preprocessUnclosedConstructs('The value $x$ is here.')).toBe('The value $x$ is here.');
  });

  it('ignores escaped \\$', () => {
    expect(preprocessUnclosedConstructs('price is \\$5')).toBe('price is \\$5');
  });

  it('closes an unclosed ``` fenced code block', () => {
    expect(preprocessUnclosedConstructs('```ts\nconst a = 1;')).toBe('```ts\nconst a = 1;\n```');
  });

  it('closes a tilde fence', () => {
    expect(preprocessUnclosedConstructs('~~~\nsome script\n')).toBe('~~~\nsome script\n\n~~~');
  });

  it('does not close a properly closed fence', () => {
    expect(preprocessUnclosedConstructs('```ts\nconst a = 1;\n```')).toBe('```ts\nconst a = 1;\n```');
  });

  it('does not double-close when tilde-like line precedes closing fence', () => {
    const input = '```ts\nconst a = 1;\n~~~\n';
    expect(preprocessUnclosedConstructs(input)).toBe('```ts\nconst a = 1;\n~~~\n\n```');
  });

  it('does nothing for ordinary text', () => {
    expect(preprocessUnclosedConstructs('Just some prose.')).toBe('Just some prose.');
  });

  it('closes unclosed code fence in the middle of a document', () => {
    const input = 'Some prose.\n\n```ts\nconst a = 1;\nconst b = 2;';
    const out = preprocessUnclosedConstructs(input);
    expect(out).toContain('```ts\nconst a = 1;\nconst b = 2;\n```');
  });
});

describe('preprocessUnclosedConstructs — code fence glued to prose', () => {
  it('splits opening ``` fence off a prose line', () => {
    const input = 'Here is code:```ts\nconst a = 1;\n```';
    const out = preprocessUnclosedConstructs(input);
    // The prose and the fence should now be on separate lines.
    expect(out).toContain('Here is code:\n```ts');
  });

  it('does not touch ``` on its own line', () => {
    const input = '```ts\nconst a = 1;\n```';
    expect(preprocessUnclosedConstructs(input)).toBe(input);
  });

  it('handles ``` with no info string glued to prose', () => {
    const input = 'intro```\nconst a = 1;\n```';
    const out = preprocessUnclosedConstructs(input);
    expect(out).toContain('intro\n```');
  });

  it('splits closing ``` fence off a line of body prose', () => {
    // LLM sometimes emits the closing fence glued to the last line of code:
    // `last line```\n` — the renderer needs a standalone ``` to close the block.
    const input = '```ts\nconst a = 1;\nlast line```\n';
    const out = preprocessUnclosedConstructs(input);
    expect(out).toContain('last line\n```');
  });

  it('closes an unclosed ``` whose info string is glued to prose', () => {
    // Real-world case: the assistant emits `\`\`\`iter N 开始\n ... body ...`
    // and the stream truncates before the close. After normalization the
    // text should still be closeable — the helper appends ``` at end.
    const input = '```iter N 开始\nStep 1\nStep 2\nStep 3';
    const out = preprocessUnclosedConstructs(input);
    expect(out.trimEnd().endsWith('```')).toBe(true);
  });

  it('preserves ASCII art inside an unstyled ``` block when a prior block had a glued close fence', () => {
    // Regression: when the previous code block ends with a glued close
    // (`...训练数据\`\`\``), the fence counter must still treat the NEXT
    // standalone ``` line as an opener, so the ASCII art body lines are
    // not silently swallowed into the previous block.
    const input = [
      'intro',
      '```',
      'body 1',
      'body 2 ends```',          // glued close
      '```',                     // ASCII block open
      '┌──┐',
      '│ hi │',
      '└──┘',
      '```',                     // ASCII block close
      'after',
    ].join('\n');
    const out = preprocessUnclosedConstructs(input);
    // ASCII art must survive intact.
    expect(out).toContain('┌──┐');
    expect(out).toContain('│ hi │');
    expect(out).toContain('└──┘');
    // Both fences must remain present and balanced.
    const fences = out.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});
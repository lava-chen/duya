import { describe, it, expect } from 'vitest';
import { tokenizeInline, renderInlineTokens, type InlineToken } from '../markdown/inline.js';
import { stylesOf, renderOneBlock, escapeTags } from '../transcript-view.js';
import { TranscriptModel } from '../blocks.js';

const styles = stylesOf({});

/** A tiny deterministic PRNG so the fuzz corpus is reproducible in CI. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * V5: every `{tag}` the renderer emits must close in LIFO order. Anything
 * unbalanced leaks attribute state into the rest of the blessed frame, which
 * is the failure mode the old flat-style convention existed to prevent.
 *
 * `{open}` / `{close}` are escaped braces, not tags — skip them. The scan runs
 * on the RAW render: an escaped brace's `{` is already inside `{open}`, so it
 * can never be mistaken for a tag opener here.
 */
function expectTagsBalanced(rendered: string): void {
  const stack: string[] = [];
  for (const match of rendered.matchAll(/\{(\/?)([a-zA-Z0-9-]+)\}/gu)) {
    const name = match[2] ?? '';
    if (name === 'open' || name === 'close') continue;
    if (match[1] !== '/') {
      stack.push(name);
      continue;
    }
    const top = stack.pop();
    expect(top, `closing {/${name}} does not match the open {${top ?? '∅}'}`).toBe(name);
  }
  expect(stack, `unclosed tags remain: ${stack.join(', ')}`).toEqual([]);
}

describe('tokenizeInline', () => {
  it('splits code, strong, emphasis, and text at the boundaries the old regex found', () => {
    const tokens = tokenizeInline('a **b** `c` *d* _e_ f');
    expect(tokens).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'text', text: ' ' },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'text', text: ' f' },
    ]);
  });

  it('nests strong around emphasis, which the regex could never express', () => {
    const tokens = tokenizeInline('**bold *inner* tail**');
    expect(tokens).toEqual([{
      kind: 'strong',
      children: [
        { kind: 'text', text: 'bold ' },
        { kind: 'emphasis', children: [{ kind: 'text', text: 'inner' }] },
        { kind: 'text', text: ' tail' },
      ],
    }]);
  });

  it('gives code spans the highest claim and never rescans their content', () => {
    expect(tokenizeInline('`**not bold** *x* [a](b)`')).toEqual([{
      kind: 'code',
      text: '**not bold** *x* [a](b)',
    }]);
  });

  it('honours same-length code fences and keeps longer runs as content', () => {
    expect(tokenizeInline('`` a```b ``')).toEqual([{ kind: 'code', text: ' a```b ' }]);
  });

  it('consumes backslash escapes before any other rule', () => {
    expect(tokenizeInline('\\*literal\\* and \\`code\\`')).toEqual([{
      kind: 'text',
      text: '*literal* and `code`',
    }]);
  });

  it('leaves a backslash before a non-punctuation character alone', () => {
    expect(tokenizeInline('C:\\Users\\path')).toEqual([{ kind: 'text', text: 'C:\\Users\\path' }]);
  });

  it('keeps single underscores inside identifiers as text', () => {
    expect(tokenizeInline('snake_case stays_whole')).toEqual([{
      kind: 'text',
      text: 'snake_case stays_whole',
    }]);
  });

  it('emphasizes a leading underscore only at a word boundary', () => {
    const tokens = tokenizeInline('_leading_ word');
    expect(tokens).toEqual([
      { kind: 'emphasis', children: [{ kind: 'text', text: 'leading' }] },
      { kind: 'text', text: ' word' },
    ]);
  });

  it('parses links into label plus target', () => {
    expect(tokenizeInline('see [docs](https://example.com/a) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', label: 'docs', target: 'https://example.com/a' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('treats a link with spaces in the target as plain text, not half a URL', () => {
    expect(tokenizeInline('[a](bad url)')).toEqual([{ kind: 'text', text: '[a](bad url)' }]);
  });

  it('renders an unmatched opener as text instead of eating the line', () => {
    expect(tokenizeInline('**a*')).toEqual([
      { kind: 'text', text: '*' },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'a' }] },
    ]);
    expect(tokenizeInline('a ** b')).toEqual([{ kind: 'text', text: 'a ** b' }]);
  });

  it('separates an image into alt, target, and its own kind', () => {
    expect(tokenizeInline('![chart](/img.png)')).toEqual([
      { kind: 'image', alt: 'chart', target: '/img.png' },
    ]);
  });
});

describe('renderInlineTokens', () => {
  it('maps each token kind to the style the old regex path used', () => {
    const rendered = renderInlineTokens(tokenizeInline('x **b** `c` *e* ~~s~~'), styles);
    expect(rendered).toBe(
      `x {bold}b{/bold} {gray-fg}c{/gray-fg} {cyan-fg}e{/cyan-fg} {gray-fg}s{/gray-fg}`,
    );
  });

  it('renders a link as label plus a muted-parenthesised target', () => {
    expect(renderInlineTokens(tokenizeInline('[docs](https://e.com)'), styles))
      .toBe('docs {gray-fg}(https://e.com){/gray-fg}');
  });

  it('renders an image as alt plus an [image] badge plus the target (D8)', () => {
    expect(renderInlineTokens(tokenizeInline('![chart](/img.png)'), styles))
      .toBe('chart {gray-fg}[image]{/gray-fg} {gray-fg}(/img.png){/gray-fg}');
  });

  it('escapes braces in text payloads exactly once', () => {
    const rendered = renderInlineTokens(tokenizeInline('{a} **{b}**'), styles);
    expect(rendered).toBe('{open}a} {bold}{open}b}{/bold}');
  });
});

describe('inline render fuzz — pairing, line count, and injection', () => {
  const SIGILS = ['**', '__', '*', '_', '~~', '`', '[', ']', '(', ')', '!', '\\', '{', '}', ' ', 'a', '好'];
  const random = mulberry32(0x614);

  const randomInline = (): string => {
    const length = 1 + Math.floor(random() * 24);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      text += SIGILS[Math.floor(random() * SIGILS.length)] ?? '';
    }
    return text;
  };

  it('keeps tags balanced and the output single-line for 2,000 random inputs', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const source = randomInline();
      const rendered = renderInlineTokens(tokenizeInline(source), styles);
      expectTagsBalanced(rendered);
      expect(rendered, `newline leaked from ${JSON.stringify(source)}`).not.toContain('\n');
    }
  });

  it('never executes model markup: sigils wrapped in braces stay literal', () => {
    const sources = ['{bold}x{/bold}', '{/gray-fg}', '{{}}', '{open}'];
    for (const source of sources) {
      const rendered = renderInlineTokens(tokenizeInline(source), styles);
      expect(rendered).toBe(escapeTags(source));
    }
  });

  it('preserves the block line count for any paragraph (V7, tokenizer share)', () => {
    for (let i = 0; i < 500; i += 1) {
      const source = randomInline();
      // Block constructs (a fenced code line) legitimately change the line
      // count — the invariant covers the inline path, so keep those out.
      if (/```|~~~/u.test(source)) continue;
      const model = new TranscriptModel();
      model.finalizeText(source);
      const block = model.blocks[0];
      if (block === undefined) continue;
      const rendered = renderOneBlock(block, stylesOf({}));
      // The `● ` anchor is an inline prefix on the first row, not a new row.
      expect(rendered.split('\n').length).toBe(source.split('\n').length);
    }
  });
});

describe('token type exhaustive rendering', () => {
  it('renders every token kind without dropping one', () => {
    const tokens: readonly InlineToken[] = [
      { kind: 'text', text: 't' },
      { kind: 'code', text: 'c' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'strike', children: [{ kind: 'text', text: 's' }] },
      { kind: 'link', label: 'L', target: '/u' },
      { kind: 'image', alt: 'A', target: '/i' },
    ];
    const rendered = renderInlineTokens(tokens, styles);
    expect(rendered).toBe(
      't{gray-fg}c{/gray-fg}{bold}b{/bold}{cyan-fg}e{/cyan-fg}{gray-fg}s{/gray-fg}' +
      'L {gray-fg}(/u){/gray-fg}A {gray-fg}[image]{/gray-fg} {gray-fg}(/i){/gray-fg}',
    );
    expectTagsBalanced(rendered);
  });
});

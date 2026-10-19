/**
 * The span layer (plan 615 Phase 1, V1).
 *
 * ## What these tests are for
 *
 * The refactor's whole claim is "the tag string is now a VIEW over spans, and
 * nothing about the rendered result changed". Two kinds of test hold it:
 *
 * - **Equivalence against the other serializer.** For every corpus line the
 *   ANSI writer (`spansToAnsi`) and the tag writer followed by the tag parser
 *   (`renderMarkup(spansToTags(…))`) must produce the SAME BYTES. They are
 *   independent implementations of the same rule, so agreeing is evidence and
 *   not a tautology.
 * - **Invariants of the representation.** Attribute order, colour replacement
 *   (innermost wins), text preservation (the width budget is computed from
 *   `spanText`, so a lost character is a clipped line), and the OSC 8 no-op.
 *
 * The legacy tag strings themselves are pinned by `inline-tokens.test.ts` and
 * `tui-transcript-markup.test.ts`; those files are unchanged by design, which
 * is why they are the real proof that the view is byte-compatible.
 */

import { describe, expect, it } from 'vitest';

import { indexedColor, namedColor, tagBodyFor, colorFromTagBody, sgrParameterFor } from '../core/color.js';
import {
  attrs,
  mergeSpanStyles,
  spanText,
  tokensToSpans,
  withSpanStyle,
  type InlineSpanRoles,
  type StyledSpan,
} from '../core/span.js';
import { tokenizeInline } from '../markdown/inline.js';
import { renderInlineTokens, spanRolesOf, spansToTags, tagViewOf } from '../markdown/inline.js';
import { spansToAnsi } from '../terminal/ansi.js';
import { renderMarkup } from '../screen/own/markup.js';
import { stylesOf } from '../transcript-view.js';

const ROLES: InlineSpanRoles = {
  muted: namedColor('gray')!,
  accent: namedColor('cyan')!,
  link: namedColor('gray')!,
};

const OWN = stylesOf({ renderer: 'own' });
const BLESSED = stylesOf({ renderer: 'blessed' });

/** Lower one line of Markdown to spans with the dark theme's roles. */
function spans(markdown: string): readonly StyledSpan[] {
  return tokensToSpans(tokenizeInline(markdown), ROLES);
}

describe('colour vocabulary', () => {
  it('keeps named and indexed colours distinct', () => {
    // `{cyan-fg}` is the terminal's own cyan (SGR 36); `{6-fg}` is palette
    // entry 6. A themed terminal may make them different colours, so they must
    // not collapse into one value.
    expect(tagBodyFor(namedColor('cyan')!)).toBe('cyan-fg');
    expect(tagBodyFor(indexedColor(6)!)).toBe('6-fg');
    expect(sgrParameterFor(namedColor('cyan')!)).toBe('36');
    expect(sgrParameterFor(indexedColor(241)!)).toBe('38;5;241');
  });

  it('accepts every spelling blessed accepts and remembers the one it was given', () => {
    expect(colorFromTagBody('bright-green-fg')).toEqual({ kind: 'named', name: 'brightgreen' });
    expect(colorFromTagBody('brightgreen-fg')).toEqual({ kind: 'named', name: 'brightgreen' });
    // Round-trips its spelling rather than normalising to `gray`: the tag layer
    // is still on the wire, so `{grey-fg}` must not silently become `{gray-fg}`.
    expect(tagBodyFor(colorFromTagBody('grey-fg')!)).toBe('grey-fg');
  });

  it('rejects out-of-range and non-colour bodies', () => {
    expect(colorFromTagBody('256-fg')).toBeUndefined();
    expect(colorFromTagBody('nope-fg')).toBeUndefined();
    expect(colorFromTagBody('bold')).toBeUndefined();
    expect(colorFromTagBody('-fg')).toBeUndefined();
  });
});

describe('tokensToSpans', () => {
  it('maps every token kind to the style it means', () => {
    const lowered = spans('t **b** `c` *e* ~~s~~');
    expect(spanText(lowered)).toBe('t b c e s');
    expect(lowered.map((span) => ({ text: span.text, attrs: span.attrs, fg: span.fg?.kind === 'named' ? span.fg.name : span.fg?.index }))).toEqual([
      { text: 't ', attrs: undefined, fg: undefined },
      { text: 'b', attrs: ['bold'], fg: undefined },
      { text: ' ', attrs: undefined, fg: undefined },
      { text: 'c', attrs: undefined, fg: 'gray' },
      { text: ' ', attrs: undefined, fg: undefined },
      { text: 'e', attrs: ['italic'], fg: undefined },
      { text: ' ', attrs: undefined, fg: undefined },
      { text: 's', attrs: ['strike'], fg: undefined },
    ]);
  });

  it('is renderer-agnostic: emphasis is italic even for the blessed chain', () => {
    // The blessed fold is a SERIALISER decision. Baking it in here would make
    // the shared representation blessed-shaped and would leak into any output
    // that can paint italic (plan 615 V8).
    const lowered = spans('*e*');
    expect(lowered).toHaveLength(1);
    expect(lowered[0]?.attrs).toEqual(['italic']);
    expect(lowered[0]?.fg).toBeUndefined();
  });

  it('composes nested constructs into one flat style', () => {
    const lowered = spans('**a `b` c**');
    expect(spanText(lowered)).toBe('a b c');
    expect(lowered.map((span) => span.text)).toEqual(['a ', 'b', ' c']);
    // Inner colour replaces the outer one; the attribute survives.
    expect(lowered[1]).toMatchObject({ text: 'b', attrs: ['bold'], fg: { kind: 'named', name: 'gray' } });
    expect(lowered[2]).toMatchObject({ text: ' c', attrs: ['bold'] });
    expect(lowered[2]?.fg).toBeUndefined();
  });

  it('keeps the link and image shapes the renderer already shipped', () => {
    expect(spanText(spans('[docs](https://e.com)'))).toBe('docs (https://e.com)');
    expect(spanText(spans('![chart](/img.png)'))).toBe('chart [image] (/img.png)');
    const image = spans('![chart](/img.png)');
    expect(image.map((span) => span.text)).toEqual(['chart ', '[image]', ' ', '(/img.png)']);
    expect(image[1]?.fg).toEqual(ROLES.muted);
    expect(image[3]?.fg).toEqual(ROLES.link);
  });

  it('preserves text exactly, which is what the width budget depends on', () => {
    // `spanText` is what the line's width is measured from, so a dropped or
    // duplicated character here becomes a wrapped or clipped line everywhere
    // downstream. Expected values are spelled out rather than derived: deriving
    // them would only re-state the tokenizer.
    const cases: readonly (readonly [string, string])[] = [
      ['a{b}c', 'a{b}c'],
      ['你好世界', '你好世界'],
      ['**粗** *斜*', '粗 斜'],
      ['`x`~~y~~', 'xy'],
      ['\\*not em\\*', '*not em*'],
      ['[a](b)', 'a (b)'],
      ['![a](b)', 'a [image] (b)'],
    ];
    for (const [source, expected] of cases) {
      expect(spanText(spans(source)), `for ${JSON.stringify(source)}`).toBe(expected);
    }
  });
});

describe('style algebra', () => {
  it('normalises attribute order so serialisation is deterministic', () => {
    expect(attrs('strike', 'bold')).toEqual(['bold', 'strike']);
    expect(attrs('bold', 'bold')).toEqual(['bold']);
    expect(attrs(false, undefined)).toEqual([]);
  });

  it('lets the inner colour win and unions the attributes', () => {
    const merged = mergeSpanStyles(
      { fg: namedColor('cyan')!, attrs: ['bold'] },
      { fg: namedColor('gray')!, attrs: ['italic'] },
    );
    expect(merged.fg).toEqual(namedColor('gray'));
    expect(merged.attrs).toEqual(['bold', 'italic']);
  });

  it('never allocates a style when the envelope is empty', () => {
    const lowered = spans('plain');
    expect(withSpanStyle(lowered, {})).toBe(lowered);
  });
});

describe('spansToTags — the compatibility view', () => {
  it('keeps the tag strings byte-identical to the pre-span renderer', () => {
    // The same expectations as `inline-tokens.test.ts`; duplicated here so a
    // regression points at the span layer rather than at the tokenizer tests.
    expect(renderInlineTokens(tokenizeInline('x **b** `c` *e* ~~s~~'), BLESSED))
      .toBe('x {bold}b{/bold} {gray-fg}c{/gray-fg} {cyan-fg}e{/cyan-fg} {gray-fg}s{/gray-fg}');
    expect(renderInlineTokens(tokenizeInline('*e* ~~s~~'), OWN)).toBe('{italic}e{/italic} {strike}s{/strike}');
    expect(renderInlineTokens(tokenizeInline('{a} **{b}**'), OWN)).toBe('{open}a} {bold}{open}b}{/bold}');
  });

  it('keeps the envelope outermost so a heading colour survives inner bold', () => {
    // Pinned in `tui-transcript-markup.test.ts`; restated here because the
    // envelope is what replaced the manual tag-pair wrapping.
    expect(renderInlineTokens(tokenizeInline('结果'), OWN, { fg: namedColor('cyan')!, attrs: ['bold'] }))
      .toBe('{cyan-fg}{bold}结果{/bold}{/cyan-fg}');
  });

  it('does not close and reopen a tag the next span still needs', () => {
    // Minimal transitions: the whole point of diffing the effective style.
    expect(spansToTags(spans('**a `b` c**'), tagViewOf(OWN)))
      .toBe('{bold}a {gray-fg}b{/gray-fg} c{/bold}');
  });

  it('degrades italic and strike to colours only for blessed', () => {
    const view = tagViewOf(BLESSED);
    expect(spansToTags(spans('*e* ~~s~~'), view)).toBe('{cyan-fg}e{/cyan-fg} {gray-fg}s{/gray-fg}');
    expect(spansToTags(spans('*e* ~~s~~'), tagViewOf(OWN))).toBe('{italic}e{/italic} {strike}s{/strike}');
  });

  it('leaves every tag balanced', () => {
    const corpus = ['**a *b* c**', '# x', '`a{b` **c**', '[l](t) ![a](t)', '~~a **b** c~~'];
    for (const source of corpus) {
      const rendered = spansToTags(spans(source), tagViewOf(OWN));
      const stack: string[] = [];
      for (const match of rendered.matchAll(/\{(\/?)([a-zA-Z0-9-]+)\}/gu)) {
        const name = match[2] ?? '';
        if (name === 'open' || name === 'close') continue;
        if (match[1] === '/') expect(stack.pop()).toBe(name);
        else stack.push(name);
      }
      expect(stack, `unclosed in ${JSON.stringify(source)}`).toEqual([]);
    }
  });
});

describe('spansToAnsi', () => {
  it('emits one sequence per style change rather than one per span', () => {
    const ansi = spansToAnsi([
      { text: 'a', attrs: ['bold'] },
      { text: 'b', fg: indexedColor(241) },
      { text: 'c', attrs: ['bold'] },
    ]);
    expect(ansi).toBe('\x1b[1ma\x1b[m\x1b[38;5;241mb\x1b[m\x1b[1mc\x1b[m');
  });

  it('does not reset before the first styled run, matching the tag path', () => {
    expect(spansToAnsi([{ text: 'a' }, { text: 'b', attrs: ['bold'] }])).toBe('a\x1b[1mb\x1b[m');
  });

  it('merges attributes and colour into one sequence, attributes first', () => {
    expect(spansToAnsi([{ text: 'x', attrs: ['bold', 'italic'], fg: indexedColor(241) }]))
      .toBe('\x1b[1;3;38;5;241mx\x1b[m');
  });

  it('treats linkId as a no-op (OSC 8 is reserved, not emitted)', () => {
    const withLink = spansToAnsi([{ text: 'a', fg: namedColor('gray')!, linkId: 'x' }]);
    const without = spansToAnsi([{ text: 'a', fg: namedColor('gray')! }]);
    expect(withLink).toBe(without);
    expect(withLink).not.toContain('\x1b]');
  });

  it('agrees byte-for-byte with the tag path on the same spans', () => {
    // Two independent serialisers. If either drifts — an extra reset, a
    // reordered parameter, a colour lost in one of them — the screen would
    // differ depending on which renderer is active, which is exactly the class
    // of bug the parity work exists to prevent.
    const corpus = [
      'plain text',
      '**bold** and `code`',
      '**a `b` c**',
      '*em* ~~strike~~ **both *nested* here**',
      '[label](https://example.com/path)',
      '![alt](/img.png)',
      '`a{b` and {brace}',
      '你好 **世界** *斜体*',
      '**a** **b** **c**',
      '',
    ];
    for (const source of corpus) {
      const lowered = spans(source);
      const tags = spansToTags(lowered, tagViewOf(OWN));
      expect(spansToAnsi(lowered), `differ for ${JSON.stringify(source)}`).toBe(renderMarkup(tags));
    }
  });

  it('agrees with the tag path across the fuzz corpus too', () => {
    // Deterministic corpus, no PRNG: the point is breadth over the sigils the
    // tokenizer can produce, not statistical coverage.
    const pieces = ['**', '*', '`', '~~', '[', '](', ')', '!', '\\', '{', '}', 'a', '好', ' '];
    let seed = 0x615;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iteration = 0; iteration < 500; iteration += 1) {
      let source = '';
      const length = 1 + Math.floor(random() * 12);
      for (let index = 0; index < length; index += 1) {
        source += pieces[Math.floor(random() * pieces.length)] ?? '';
      }
      const lowered = spans(source);
      const tags = spansToTags(lowered, tagViewOf(OWN));
      expect(spansToAnsi(lowered), `differ for ${JSON.stringify(source)}`).toBe(renderMarkup(tags));
    }
  });
});

describe('roles resolve from the theme', () => {
  it('reads the colour behind each semantic token', () => {
    expect(spanRolesOf(OWN)).toEqual({
      muted: { kind: 'named', name: 'gray' },
      accent: { kind: 'named', name: 'cyan' },
      link: { kind: 'named', name: 'gray' },
    });
  });

  it('reads the light palette’s indexed colours without inventing names', () => {
    const light = stylesOf({ renderer: 'own', theme: {
      muted: '243-fg', accent: '30-fg', success: '28-fg', error: '160-fg', warning: '172-fg',
      user: '28-fg', thinking: '128-fg', diffAdd: '28-fg', diffDel: '160-fg', heading: '30-fg', link: '243-fg',
    } });
    expect(spanRolesOf(light).muted).toEqual({ kind: 'indexed', index: 243 });
  });
});

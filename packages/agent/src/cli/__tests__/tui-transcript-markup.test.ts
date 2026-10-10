import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../ui/blocks.js';
import { renderTranscript, escapeTags } from '../ui/transcript-view.js';

/**
 * Rendered markup must not survive into the text.
 *
 * ## The defect this pins down
 *
 * The user line was rendered as `c.brightGreen(c.bold('›'))`. That nests two
 * tagged helpers and produces
 * `{brightGreen-fg}{bold}›{/bold}{/brightGreen-fg}` — and blessed's tag parser
 * does not consume a closing tag whose opener it has already left. So
 * `{/brightGreen-fg}` was printed literally, and every user message in a live
 * TUI read:
 *
 *     {brightGreen-fg}{/brightGreen-fg} 你是谁
 *
 * A guard that only asserted "the user text is present" would have passed
 * against that, because the text WAS present — next to the leaked markup. The
 * assertions below are therefore on what must NOT appear.
 *
 * ## What these tests can and cannot prove
 *
 * They pin the string this module EMITS. They do not pin blessed's tag parser:
 * whether a given string prints as markup or as text is decided inside blessed,
 * and no assertion here reaches it. So the "nested markup leaks" fact is taken
 * from the observed screen output, not derived here — what is enforced is that
 * this module never emits a nested style in the first place, which removes the
 * input that produced the leak rather than filtering its output.
 */

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5 };

function render(): string {
  const model = new TranscriptModel();
  model.addUser('你是谁');
  model.addNotice('45 tools available');
  return renderTranscript(model, OPTIONS);
}

describe('transcript-view markup', () => {
  it('emits no empty styled run, which is what survived the parser', () => {
    // The leaked shape on a real screen was the opener immediately followed by
    // its closer: blessed consumed the inner `{bold}›{/bold}` and then printed
    // the outer pair as text.
    expect(render()).not.toContain('{brightGreen-fg}{/brightGreen-fg}');
  });

  it('leaves no closing tag for any style it opens', () => {
    const rendered = render();
    const opened = new Set<string>();
    for (const match of rendered.matchAll(/\{([a-zA-Z-]+)\}/g)) {
      const name = match[1] as string;
      if (name.startsWith('/')) continue;
      opened.add(name);
    }
    for (const name of opened) {
      expect(rendered, `style ${name} is opened but never closed`).toContain(`{/${name}}`);
    }
  });

  it('still prints the user text itself', () => {
    expect(render()).toContain('你是谁');
  });

  it('brackets the user line in exactly one balanced style', () => {
    const rendered = render();
    // Flat by design: the nested form leaked its outer closing tag.
    expect(rendered).toContain('{brightGreen-fg}› 你是谁{/brightGreen-fg}');
  });

  it('escapes braces in model output rather than letting blessed eat them', () => {
    const model = new TranscriptModel();
    model.appendTextDelta('const x = { a: 1 };');
    const rendered = renderTranscript(model, OPTIONS);
    // `{ a: 1 }` would otherwise be read as an unterminated tag and dropped.
    expect(rendered).toContain('\\{');
    expect(rendered).toContain('a: 1');
  });

  it('escapes braces in a NOTICE too, which the leak-prone arm used to skip', () => {
    const model = new TranscriptModel();
    model.addNotice('payload {brightRed-fg}red{/brightRed-fg}');
    const rendered = renderTranscript(model, OPTIONS);
    // Exactly one unescaped opener would be the payload; the real style's
    // opener plus an escaped copy is what a correct render looks like.
    expect(rendered).toContain('\\{brightRed-fg}');
  });
});

describe('escapeTags', () => {
  it('escapes every brace, not just the first', () => {
    expect(escapeTags('{a}{b}')).toBe('\\{a}\\{b}');
  });

  it('leaves text without braces alone', () => {
    expect(escapeTags('plain text')).toBe('plain text');
  });
});
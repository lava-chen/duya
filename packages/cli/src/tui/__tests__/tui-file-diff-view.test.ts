import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript } from '../transcript-view.js';
import { diffRowWidth } from '../file-diff-view.js';

/**
 * The file-change block: a tool that changed a file draws its change set.
 *
 * The rows are not computed by the renderer — the tool computed them and
 * published them in its result metadata — so these tests pin the PAINTING:
 * which colours land on which row, that a context row stays unpainted, and
 * that no row ever outgrows the pane.
 */

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5, width: 60 };

/** Drop blessed tags so layout assertions read the text a user sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

const DIFF = {
  path: 'src/app.ts',
  added: 1,
  removed: 1,
  hunks: [
    {
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 3,
      lines: [
        { kind: 'context', text: 'const ready = true;', oldLine: 12, newLine: 12 },
        { kind: 'remove', text: 'const legacy = true;', oldLine: 13, newLine: null },
        { kind: 'add', text: 'const store = createStore();', oldLine: null, newLine: 13 },
      ],
    },
  ],
};

function modelWithDiff(diff: unknown, failures?: string[]): TranscriptModel {
  const model = new TranscriptModel();
  model.apply({ type: 'tool_use', data: { id: 'call-1', name: 'edit', input: { file_path: 'src/app.ts' } } });
  model.apply({
    type: 'tool_result',
    data: {
      id: 'call-1',
      result: 'Successfully edited src/app.ts: 1 block changed.',
      metadata: { diff: [diff], ...(failures === undefined ? {} : { failures }) },
    },
  });
  return model;
}

describe('file change block', () => {
  it('shows the change size on the tool row instead of the prose line count', () => {
    const rendered = renderTranscript(modelWithDiff(DIFF), OPTIONS);
    expect(rendered).toContain('edit(src/app.ts)');
    expect(rendered).toContain('{bright-green-fg}+1{/bright-green-fg}');
    expect(rendered).toContain('{red-fg}-1{/red-fg}');
    // The prose line count says nothing about the change, so it is gone.
    expect(rendered).not.toContain('lines]');
  });

  it('draws the rows with their line numbers and the divider', () => {
    const rendered = strip(renderTranscript(modelWithDiff(DIFF), OPTIONS));
    // The sign column is one character wide, so a context row's content starts
    // one column further right than the divider.
    expect(rendered).toContain('12 │  const ready = true;');
    expect(rendered).toContain('13 │ -const legacy = true;');
    expect(rendered).toContain('13 │ +const store = createStore();');
  });

  it('escapes a brace in the content instead of letting the tag parser eat it', () => {
    const withBrace = {
      ...DIFF,
      hunks: [{
        ...DIFF.hunks[0],
        lines: [{ kind: 'context', text: 'function boot() {', oldLine: 12, newLine: 12 }],
      }],
    };
    const rendered = renderTranscript(modelWithDiff(withBrace), OPTIONS);
    // Blessed reads `{open}` as a literal brace; without the escape the parser
    // would swallow it as the start of a tag.
    expect(rendered).toContain('{open}');
  });

  it('paints an added row with the add fill and a removed row with the del fill', () => {
    const rendered = renderTranscript(modelWithDiff(DIFF), OPTIONS);
    const added = rendered.split('\n').find((line) => line.includes('const store = createStore();'));
    const removed = rendered.split('\n').find((line) => line.includes('const legacy = true;'));
    const context = rendered.split('\n').find((line) => line.includes('const ready = true;'));
    expect(added).toContain('{22-bg}');
    expect(added).toContain('{23-bg}');
    expect(removed).toContain('{52-bg}');
    expect(removed).toContain('{53-bg}');
    // Unchanged code is not part of the change, so it carries no fill at all.
    expect(context).not.toContain('-bg}');
  });

  it('paints the divider, so a handled row has no gap through the middle', () => {
    // The number sits on its own chip, but everything from the divider to the
    // right edge is one fill. Leaving the divider unpainted cut a stripe of
    // terminal background through the row, which reads as a broken line.
    const rendered = renderTranscript(modelWithDiff(DIFF), OPTIONS);
    const added = rendered.split('\n').find((line) => line.includes('const store = createStore();')) ?? '';
    const removed = rendered.split('\n').find((line) => line.includes('const legacy = true;')) ?? '';
    expect(added).toContain('{22-bg} │ ');
    expect(removed).toContain('{52-bg} │ ');
  });

  it('never lets a row outgrow the pane', () => {
    const rendered = renderTranscript(modelWithDiff(DIFF), OPTIONS);
    for (const line of rendered.split('\n')) {
      expect(diffRowWidth(line)).toBeLessThanOrEqual(59);
    }
  });

  it('names every file when the change touched more than one', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'call-2', name: 'apply_patch', input: { patch: '*** Begin Patch' } } });
    model.apply({
      type: 'tool_result',
      data: {
        id: 'call-2',
        result: 'Applied 2 operation(s)',
        metadata: {
          diff: [
            DIFF,
            { ...DIFF, path: 'src/other.ts', added: 0, removed: 2 },
          ],
        },
      },
    });
    const rendered = strip(renderTranscript(model, OPTIONS));
    expect(rendered).toContain('src/app.ts');
    expect(rendered).toContain('src/other.ts');
  });

  it('renders the operations that failed', () => {
    const rendered = renderTranscript(modelWithDiff(DIFF, ['src/b.ts: apply_patch verification failed']), OPTIONS);
    expect(rendered).toContain('✗ src/b.ts: apply_patch verification failed');
    expect(rendered).toContain('{bright-red-fg}');
  });

  it('says the change was too large instead of drawing nothing', () => {
    const rendered = strip(renderTranscript(
      modelWithDiff({ ...DIFF, truncated: true, hunks: [] }),
      OPTIONS,
    ));
    expect(rendered).toContain('change too large to show row by row');
  });

  it('leaves no closing tag for any style it opens', () => {
    const rendered = renderTranscript(modelWithDiff(DIFF), OPTIONS);
    const opened = new Set<string>();
    for (const match of rendered.matchAll(/\{([a-zA-Z-]+)\}/gu)) {
      const name = match[1] as string;
      if (name.startsWith('/')) continue;
      // Blessed's own escape for a literal brace is the tag body `open`; it is
      // not a style this renderer opened.
      if (name === 'open' || name === 'close') continue;
      opened.add(name);
    }
    for (const name of opened) {
      expect(rendered, `style ${name} is opened but never closed`).toContain(`{/${name}}`);
    }
  });
});

/**
 * The retained component tree (plan 615 Phase 3).
 *
 * ## The two claims under test
 *
 * 1. **The containers reproduce the geometry solver.** The region layout is
 *    currently a switch over region names in `screen/own/geometry.ts`. Its
 *    successor is a tree, and a tree is only a successor if it puts every
 *    region in exactly the same box — one cell off and every snapshot test in
 *    the suite starts arguing with the layout instead of with the renderer.
 *    The matrix below compares all five regions across four terminal sizes and
 *    two overlay widths.
 * 2. **A component paints exactly the string it wraps.** `StatusBar` and
 *    `QuestionPanel` still delegate their text to `buildFooterLines` and
 *    `QuestionAskState.render`. Their rows are compared as ANSI, cell for cell,
 *    which is the strongest form of "the tree changed nothing".
 */

import { describe, expect, it } from 'vitest';

import { SceneCanvas, leaf, renderTree, update, type UIComponent, type Viewport } from '../component.js';
import { HStack, Overlay, VStack, type StackSlot } from '../containers.js';
import { tagsToSpans } from '../tags.js';
import { spanText, type StyledSpan } from '../span.js';
import { spansToAnsi } from '../../terminal/ansi.js';
import { spansToTags, tagViewOf } from '../../markdown/inline.js';
import { renderMarkup } from '../../screen/own/markup.js';
import { layoutRegion, type GeometryOptions } from '../../screen/own/geometry.js';
import { buildFooterLines, type FooterInput } from '../../footer.js';
import { stylesOf } from '../../transcript-view.js';
import { QuestionAskState, parseQuestionInput } from '../../question-overlay.js';
import { StatusBar } from '../../components/status-bar.js';
import { QuestionPanel } from '../../components/question-panel.js';

const OWN = stylesOf({ renderer: 'own' });

/** A component that records the box it was painted into. */
function recorder(boxes: Map<string, Viewport>, id: string, height = 0): UIComponent<undefined> {
  return leaf(id, () => height, (_scene, viewport) => {
    boxes.set(id, viewport);
  });
}

/** The region tree, expressed the way the plan says the layout really is. */
function regionTree(boxes: Map<string, Viewport>, overlayWidth: string): UIComponent {
  const panes = new VStack('panes', [
    { component: recorder(boxes, 'transcript'), size: 'flex' },
    { component: recorder(boxes, 'input'), size: 3 },
    { component: recorder(boxes, 'status'), size: 1 },
  ]);
  const withCompletion = new Overlay('completion-layer', {
    base: panes,
    overlay: recorder(boxes, 'completion'),
    width: (viewport) => viewport.width - 8,
    height: 3,
    // Four rows above the bottom: the input's three plus the status row. That
    // is `DEFAULT_BOTTOM.completion` (3 + statusRows) expressed as an anchor
    // instead of as arithmetic on region names.
    anchor: { kind: 'bottom', bottom: 4 },
  });
  return new Overlay('overlay-layer', {
    base: withCompletion,
    overlay: recorder(boxes, 'overlay'),
    width: overlayWidth,
    height: 7,
    anchor: { kind: 'center' },
  });
}

/** Drop trailing plain spaces, so a padded canvas row compares to a tight line. */
function trimTrailing(spans: readonly StyledSpan[]): readonly StyledSpan[] {
  const out = [...spans];
  while (out.length > 0) {
    const last = out[out.length - 1] as StyledSpan;
    if ((last.fg !== undefined) || (last.bg !== undefined) || (last.attrs ?? []).length > 0) break;
    const trimmed = last.text.replace(/ +$/u, '');
    if (trimmed === last.text) break;
    if (trimmed === '') out.pop();
    else {
      out[out.length - 1] = { text: trimmed, ...(last.linkId === undefined ? {} : { linkId: last.linkId }) };
    }
  }
  return out;
}

/** One canvas row, as ANSI, for byte comparison against the legacy renderer. */
function rowAnsi(canvas: SceneCanvas, row: number): string {
  return spansToAnsi(trimTrailing(canvas.toScene().rows[row] ?? []));
}

describe('SceneCanvas', () => {
  it('writes tagged text at a column and clips at the edge', () => {
    const canvas = new SceneCanvas(10, 2);
    canvas.writeTagged(0, 2, '{bold}abc{/bold}');
    expect(canvas.textAt(0)).toBe('  abc     ');

    // A write that would run past the edge is clipped, never wrapped onto the
    // next row: the row below belongs to someone else.
    canvas.writeTagged(0, 8, 'wxyz');
    expect(canvas.textAt(0)).toBe('  abc   wx');
    expect(canvas.textAt(1)).toBe('          ');
  });

  it('keeps a wide glyph and its continuation together', () => {
    const canvas = new SceneCanvas(6, 1);
    canvas.writeTagged(0, 0, '中a');
    expect(canvas.textAt(0)).toBe('中a   ');
    // Two cells for the wide glyph: the base plus one continuation marker that
    // must not be serialised as text.
    const spans = canvas.toScene().rows[0] ?? [];
    expect(spanText(spans)).toBe('中a   ');
  });

  it('attaches a combining mark to the cell before it', () => {
    const canvas = new SceneCanvas(4, 1);
    canvas.writeTagged(0, 0, 'e\u0301x');
    // The accent belongs to the `e`; splitting it out would render two glyphs.
    expect(canvas.textAt(0)).toBe('e\u0301x  ');
  });

  it('lets an overlay overwrite cells without disturbing the rest of the row', () => {
    const canvas = new SceneCanvas(8, 1);
    canvas.writeTagged(0, 0, 'abcdefgh');
    canvas.writeTagged(0, 3, 'XY');
    expect(canvas.textAt(0)).toBe('abcXYfgh');
  });

  it('merges adjacent cells that paint identically into one span', () => {
    const canvas = new SceneCanvas(5, 1);
    canvas.writeTagged(0, 0, '{gray-fg}abcde{/gray-fg}');
    const spans = canvas.toScene().rows[0] ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe('abcde');
  });
});

describe('tagsToSpans', () => {
  it('is the inverse of the tag view for what the tag view emits', () => {
    const corpus = [
      '{bold}a{/bold} plain',
      '{gray-fg}muted{/gray-fg} and {241-fg}indexed{/241-fg}',
      '{bold}{gray-fg}both{/gray-fg}{/bold}',
      '{italic}em{/italic} {strike}gone{/strike}',
      'no tags at all',
    ];
    for (const line of corpus) {
      const spans = tagsToSpans(line);
      expect(spansToTags(spans, tagViewOf(OWN)), line).toBe(line);
    }
  });

  it('treats unknown tags as text and literal braces correctly', () => {
    expect(spanText(tagsToSpans('{nope}a'))).toBe('{nope}a');
    expect(spanText(tagsToSpans('{open}a}'))).toBe('{a}');
    // An unmatched close costs nothing: it must not unwind an outer style.
    expect(spansToTags(tagsToSpans('{bold}a{/gray-fg}b{/bold}'), tagViewOf(OWN)))
      .toBe('{bold}ab{/bold}');
  });
});

describe('containers', () => {
  it('gives the fixed slots their rows and the flex slot the remainder', () => {
    const boxes = new Map<string, Viewport>();
    const stack = new VStack('s', [
      { component: recorder(boxes, 'a'), size: 'flex' },
      { component: recorder(boxes, 'b'), size: 3 },
      { component: recorder(boxes, 'c'), size: 1 },
    ]);
    renderTree(stack, 20, 24);
    expect(boxes.get('a')).toMatchObject({ row: 0, height: 20 });
    expect(boxes.get('b')).toMatchObject({ row: 20, height: 3 });
    expect(boxes.get('c')).toMatchObject({ row: 23, height: 1 });
  });

  it('allocates the rounding remainder instead of dropping it', () => {
    const boxes = new Map<string, Viewport>();
    const stack = new VStack('s', [
      { component: recorder(boxes, 'a'), size: 'flex', weight: 1 },
      { component: recorder(boxes, 'b'), size: 'flex', weight: 1 },
    ]);
    renderTree(stack, 20, 25);
    // 25 / 2 is 12.5: the first slot takes the odd row, so the stack still tiles
    // the whole height. A dropped remainder is a visibly unpainted last row.
    expect(boxes.get('a')?.height).toBe(13);
    expect(boxes.get('b')?.height).toBe(12);
  });

  it('insets a slot from both sides', () => {
    const boxes = new Map<string, Viewport>();
    const stack = new VStack('s', [{ component: recorder(boxes, 'a'), size: 1, inset: 4 }]);
    renderTree(stack, 20, 1);
    expect(boxes.get('a')).toMatchObject({ column: 4, width: 12 });
  });

  it('stacks side by side with HStack', () => {
    const boxes = new Map<string, Viewport>();
    const stack = new HStack('h', [
      { component: recorder(boxes, 'a'), size: 5 },
      { component: recorder(boxes, 'b'), size: 'flex' },
    ]);
    renderTree(stack, 30, 4);
    expect(boxes.get('a')).toMatchObject({ column: 0, width: 5, height: 4 });
    expect(boxes.get('b')).toMatchObject({ column: 5, width: 25, height: 4 });
  });

  it('paints the overlay after the base, so it wins the shared cells', () => {
    const base = leaf('base', () => 1, (scene, viewport) => {
      scene.writeTagged(viewport.row, viewport.column, 'base text');
    });
    const overlay = leaf('over', () => 1, (scene, viewport) => {
      scene.writeTagged(viewport.row, viewport.column, 'OVER');
    });
    const scene = renderTree(new Overlay('o', {
      base,
      overlay,
      width: 4,
      height: 1,
      anchor: { kind: 'offset', row: 0, column: 0 },
    }), 12, 1);
    // Trailing padding is trimmed: the canvas is a full-width grid and the last
    // span therefore carries the blank remainder of the row.
    expect(spansToTags(trimTrailing(scene.rows[0] ?? []), tagViewOf(OWN))).toBe('OVER text');
  });
});

describe('the tree reproduces the region geometry', () => {
  const sizes = [
    { columns: 80, rows: 24 },
    { columns: 120, rows: 40 },
    { columns: 40, rows: 10 },
    { columns: 100, rows: 30 },
  ] as const;
  const widths = ['70%', '50%'] as const;

  it('puts every region in the box layoutRegion computes', () => {
    for (const size of sizes) {
      for (const overlayWidth of widths) {
        const boxes = new Map<string, Viewport>();
        renderTree(regionTree(boxes, overlayWidth), size.columns, size.rows);
        const options: GeometryOptions = { size, statusRows: 1, overlayWidth };
        for (const region of ['transcript', 'input', 'status', 'completion', 'overlay'] as const) {
          const expected = layoutRegion(region, undefined, options, true).metrics;
          const actual = boxes.get(region);
          expect(actual, `${region} missing at ${size.columns}x${size.rows}`).toBeDefined();
          expect(
            { left: actual?.column, top: actual?.row, width: actual?.width, height: actual?.height },
            `${region} at ${size.columns}x${size.rows} / ${overlayWidth}`,
          ).toEqual({ left: expected.left, top: expected.top, width: expected.width, height: expected.height });
        }
      }
    }
  });
});

describe('StatusBar', () => {
  const input = {
    cwd: '/home/ann/project',
    branch: 'main',
    sessionName: 's1',
    hint: 'Tab history',
    home: '/home/ann',
    stats: {
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      contextPercent: 42,
      contextBudget: 100_000,
      outputTokensPerSecond: null,
    },
    model: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'High' },
    styles: OWN,
  } satisfies Omit<FooterInput, 'width'>;

  it('paints exactly the rows buildFooterLines produces', () => {
    const bar = new StatusBar(input);
    const expected = buildFooterLines({ ...input, width: 80 });
    expect(bar.measure(80)).toBe(expected.length);

    const canvas = new SceneCanvas(80, 2);
    bar.paint(canvas, { row: 0, column: 0, width: 80, height: 2 });
    expect(rowAnsi(canvas, 0)).toBe(renderMarkup(expected[0] ?? ''));
    expect(rowAnsi(canvas, 1)).toBe(renderMarkup(expected[1] ?? ''));
  });

  it('reserves exactly the rows it paints, which is the point of measure()', () => {
    // The regression this replaces: a hard-coded reservation in
    // `inputChromeRows()` that could disagree with what the footer drew.
    for (const width of [40, 60, 80, 120]) {
      const bar = new StatusBar(input);
      const lines = buildFooterLines({ ...input, width });
      expect(bar.measure(width)).toBe(lines.length);
    }
  });
});

describe('QuestionPanel', () => {
  const questions = parseQuestionInput({
    questions: [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'relational' },
          { label: 'SQLite', description: 'embedded' },
        ],
      },
    ],
  });
  if (questions === null) throw new Error('fixture failed to parse');

  it('measures the rows it will paint', () => {
    const state = new QuestionAskState(questions);
    const panel = new QuestionPanel({ state });
    const lines = state.render({ queueDepth: 0 }).split('\n');
    expect(panel.measure(60)).toBe(lines.length);
  });

  it('paints the same cells the state renders', () => {
    const state = new QuestionAskState(questions);
    const panel = new QuestionPanel({ state });
    const lines = state.render({ queueDepth: 0 }).split('\n');
    // Wide enough that nothing clips: clipping is the canvas's job and is
    // covered above, while this test is about the rows being the same rows.
    const width = 120;
    const canvas = new SceneCanvas(width, lines.length);
    panel.paint(canvas, { row: 0, column: 0, width, height: lines.length });

    for (let row = 0; row < lines.length; row += 1) {
      expect(rowAnsi(canvas, row), `row ${row}`).toBe(renderMarkup(lines[row] ?? ''));
    }
  });
});

describe('update', () => {
  it('bumps the revision and changes what is painted', () => {
    const cards: StackSlot[] = [];
    void cards;
    const bar = new StatusBar({
      cwd: '/tmp',
      stats: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextPercent: null, contextBudget: null },
      styles: OWN,
    });
    const before = bar.revision;
    const canvasBefore = new SceneCanvas(40, 2);
    bar.paint(canvasBefore, { row: 0, column: 0, width: 40, height: 2 });

    update(bar, {
      cwd: '/var/log',
      stats: { inputTokens: 5, outputTokens: 0, totalTokens: 5, contextPercent: null, contextBudget: null },
      styles: OWN,
    });
    expect(bar.revision).toBe(before + 1);

    const canvasAfter = new SceneCanvas(40, 2);
    bar.paint(canvasAfter, { row: 0, column: 0, width: 40, height: 2 });
    expect(canvasAfter.textAt(0)).toContain('/var/log');
    expect(canvasAfter.textAt(1)).toContain('↑5');
  });
});

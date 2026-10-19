/**
 * Phase 0 Go/No-Go gate for plan 614 (own renderer as default).
 *
 * The two `ScreenSurface` implementations are driven through an IDENTICAL patch
 * script and their byte streams are replayed into glyph grids, which are then
 * compared cell by cell. See `render-parity.harness.ts` for the replay rules.
 *
 * This is the gate that decides whether italics can exist: blessed has no
 * `{italic}` tag, so true italics require the own renderer to become the
 * default, and that swap is only safe if the two renderers draw the same screen.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';
import blessed from 'blessed';

import { createScreenSurface } from '../screen/index.js';
import type { RegionPatch, SurfaceRegion } from '../screen/types.js';
import { renderInlineTokens, spansToTags, tagViewOf, tokenizeInline } from '../markdown/inline.js';
import { stylesOf } from '../transcript-view.js';
import { gridDiff, replay, SCREEN_COLUMNS, SCREEN_ROWS, type Grid } from './render-parity.harness.js';
type Renderer = 'blessed' | 'own';

function makeStream() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns: number; rows: number };
  stream.isTTY = true;
  stream.columns = SCREEN_COLUMNS;
  stream.rows = SCREEN_ROWS;
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function makeSurface(renderer: Renderer) {
  const output = makeStream();
  const input = new PassThrough();
  const program = blessed.program({
    input: input as unknown as NodeJS.ReadStream,
    output: output.stream as unknown as NodeJS.WriteStream,
    terminal: 'xterm-256color',
    cursor: { artificial: false, shape: 'line', blink: false, color: '' },
    colors: 256,
  });
  const surface = createScreenSurface({
    program,
    screenOptions: { program, smartCSR: true, fullUnicode: true, title: 'parity' },
    statusRows: 1,
    overlayWidth: '70%',
    output: output.stream,
    getSize: () => ({ columns: output.stream.columns, rows: output.stream.rows }),
    renderer,
  });
  surface.attachAll();
  return { surface, output };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** One step = the patches every region receives before a repaint. */
type Step = Partial<Record<SurfaceRegion, RegionPatch>>;

/**
 * The corpus. Chosen to cover every vocabulary both renderers must agree on:
 * plain flow, CJK double-width cells, blessed markup, borders, an overlay
 * raised over live content, and content churn between frames.
 */
const SCRIPT: readonly Step[] = [
  {
    transcript: { lines: ['Line one of the transcript.', 'Line two.', ''], height: 5 },
    input: { lines: ['> hello'], height: 3 },
    status: { lines: ['ctx 12% · gpt-x'] },
  },
  {
    transcript: {
      lines: ['中文宽度对齐测试：这行有全角字符。', 'second line keeps ascii only', ''],
      height: 5,
    },
  },
  {
    transcript: {
      lines: ['{bold}bolded{/bold} plain {gray-fg}muted{/gray-fg} {241-fg}indexed{/241-fg}', ''],
      height: 5,
    },
    input: { lines: ['> with **inline** and `code`'], borderColor: 'green' },
  },
  {
    // The overlay raised over live content is the case where z-order bites.
    overlay: { lines: ['Ask a question?', '1. yes', '2. no'], hidden: false, height: 7 },
  },
  {
    overlay: { hidden: true },
    transcript: { lines: ['after the overlay closes', '  indented continuation', '', 'tail'], height: 5 },
  },
  {
    transcript: { lines: [''], height: 5 },
    completion: { lines: ['/help  show commands', '/model  pick a model'], hidden: false, height: 3 },
  },
];

async function drive(renderer: Renderer): Promise<Grid[]> {
  const { surface, output } = makeSurface(renderer);
  const grids: Grid[] = [];
  try {
    for (const step of scriptFor(renderer)) {
      for (const [region, patch] of Object.entries(step) as [SurfaceRegion, RegionPatch][]) {
        surface.update(region, patch);
      }
      surface.render();
      await settle();
      grids.push(replay(output.text()));
    }
  } finally {
    surface.destroy();
  }
  return grids;
}

/**
 * Inline Markdown chosen to exercise what the span layer now decides: nested
 * constructs, a colour inside a bold run, a link, an image, and CJK next to
 * styled ASCII.
 */
const INLINE_CORPUS: readonly string[] = [
  'x **a `b` c** y',
  '**粗体** 与 `代码` 并排',
  '[docs](https://e.com)',
  '![chart](/img.png)',
  '~~del~~ and *em*',
  'plain tail line',
];

/**
 * The one step whose CONTENT depends on the renderer.
 *
 * Both renderers consume the same token tree, but each has its own tag
 * spelling for the constructs it can paint: the own renderer has `{italic}`,
 * blessed does not and folds emphasis to the accent colour. Feeding each
 * renderer the spelling it would actually receive is the point — the claim
 * being tested is "same Markdown, same glyphs", not "same bytes".
 */
function scriptFor(renderer: Renderer): readonly Step[] {
  const styles = stylesOf({ renderer });
  return [
    ...SCRIPT,
    {
      transcript: {
        lines: INLINE_CORPUS.map((markdown) => renderInlineTokens(tokenizeInline(markdown), styles)),
        height: 8,
      },
    },
  ];
}

describe('render parity (blessed vs own)', () => {
  it('draws the same glyphs for every frame of the script', async () => {
    const blessedGrids = await drive('blessed');
    const ownGrids = await drive('own');
    const frames = scriptFor('blessed').length;
    expect(scriptFor('own')).toHaveLength(frames);
    expect(blessedGrids).toHaveLength(frames);
    expect(ownGrids).toHaveLength(frames);

    for (let frame = 0; frame < frames; frame += 1) {
      const left = blessedGrids[frame] as Grid;
      const right = ownGrids[frame] as Grid;
      const differences = gridDiff(left, right);
      expect(differences, `frame ${frame + 1}`).toBe('');
    }
  });

  it('actually painted something, so the gate cannot pass vacuously', async () => {
    const [first] = await drive('own');
    const painted = (first ?? []).some((row) => row.some((cell) => cell !== ' '));
    expect(painted).toBe(true);
  });

  it('keeps the transcript line the script wrote on screen', async () => {
    const grids = await drive('own');
    const flat = (grids[0] ?? []).map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
    expect(flat).toContain('Line one of the transcript.');
  });

  it('draws the inline-Markdown frame, so the span corpus is not a no-op', async () => {
    // Both spellings must reach the screen: the own one paints italic, the
    // blessed one paints the accent fold, and neither may print a literal tag
    // or a wrong glyph. `em` is the emphasis word in the corpus.
    for (const renderer of ['blessed', 'own'] as const) {
      const grids = await drive(renderer);
      const last = (grids.at(-1) ?? []).map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
      expect(last, `${renderer} lost the emphasis word`).toContain('em');
      expect(last, `${renderer} printed a literal tag`).not.toContain('{');
      expect(last, `${renderer} lost the link label`).toContain('docs');
      expect(last, `${renderer} lost the image badge`).toContain('[image]');
    }
  });
});

/**
 * Drive one step and return the screen it produced.
 *
 * A single-frame version of `drive`, for the cases where the point is the
 * CONTENT of one frame rather than the sequence.
 */
async function driveOnce(renderer: Renderer, step: Step): Promise<Grid> {
  const { surface, output } = makeSurface(renderer);
  try {
    for (const [region, patch] of Object.entries(step) as [SurfaceRegion, RegionPatch][]) {
      surface.update(region, patch);
    }
    surface.render();
    await settle();
    return replay(output.text());
  } finally {
    surface.destroy();
  }
}

describe('span lines and tag lines paint the same screen (plan 615 Phase 5)', () => {
  const BLESSED_STYLES = stylesOf({ renderer: 'blessed' });

  /** The same content, as spans. */
  const SPANS = [
    [{ text: 'plain ' }, { text: 'muted', fg: { kind: 'named' as const, name: 'gray' } }],
    [{ text: 'bold', attrs: ['bold' as const] }, { text: ' then muted', fg: { kind: 'named' as const, name: 'gray' } }],
    [{ text: '中文与 ascii 混排' }],
    [{ text: 'indexed', fg: { kind: 'indexed' as const, index: 241 } }],
  ];

  it('draws the same glyphs whether the rows arrive as spans or as tags', async () => {
    // `own` eats the spans directly; blessed parses the tag spelling of the SAME
    // spans. If the two disagreed, moving a renderer from strings to spans would
    // silently change the screen — including where a line wraps.
    const spanned = await driveOnce('own', {
      transcript: { lines: SPANS, height: 8 },
    });
    const tagged = await driveOnce('blessed', {
      transcript: { lines: SPANS.map((line) => spansToTags(line, tagViewOf(BLESSED_STYLES))), height: 8 },
    });

    expect(gridDiff(tagged, spanned)).toBe('');
  });

  it('is not vacuous: the frame actually contains the text', async () => {
    const grid = await driveOnce('own', { transcript: { lines: SPANS, height: 8 } });
    const flat = grid.map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
    expect(flat).toContain('plain muted');
    expect(flat).toContain('中文与 ascii 混排');
    expect(flat).not.toContain('{');
  });
});

/**
 * The full-screen renderer, driven through a patch script.
 *
 * This file used to be `render-parity.test.ts`: two `ScreenSurface`
 * implementations were fed identical patches and their glyph grids compared,
 * because the swap of the default renderer was only safe if both drew the same
 * screen. Plan 615 Phase 7 deleted the second implementation, so there is
 * nothing left to compare against — and a "parity" test with one side would pass
 * by construction.
 *
 * What replaces it is the property that actually matters now: the renderer is
 * DETERMINISTIC and its frames carry the content they were given. Two runs of
 * the same script must produce identical bytes (a stray `Date.now()` or an
 * unordered map iteration in a paint path shows up here and nowhere else), and
 * every construct in the corpus must reach the screen as glyphs rather than as
 * markup.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'stream';

import { createScreenSurface } from '../screen/index.js';
import type { RegionPatch, SurfaceRegion } from '../screen/types.js';
import { renderInlineTokens, spansToTags, tagViewOf, tokenizeInline } from '../markdown/inline.js';
import { stylesOf } from '../transcript-view.js';
import { gridDiff, replay, SCREEN_COLUMNS, SCREEN_ROWS, type Grid } from './render-parity.harness.js';

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

function makeSurface() {
  const output = makeStream();
  const surface = createScreenSurface({
    statusRows: 1,
    overlayWidth: '70%',
    output: output.stream,
    getSize: () => ({ columns: output.stream.columns, rows: output.stream.rows }),
    unicodeBox: true,
  });
  surface.attachAll();
  return { surface, output };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** One step = the patches every region receives before a repaint. */
type Step = Partial<Record<SurfaceRegion, RegionPatch>>;

/**
 * The corpus. Chosen to cover every vocabulary the renderer must handle: plain
 * flow, CJK double-width cells, tag markup, borders, an overlay raised over live
 * content, and content churn between frames.
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

/**
 * Inline Markdown chosen to exercise what the span layer decides: nested
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

/** The script plus the inline-Markdown frame, spelled the way the app spells it. */
function script(): readonly Step[] {
  const styles = stylesOf({ renderer: 'own' });
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

async function drive(): Promise<Grid[]> {
  const { surface, output } = makeSurface();
  const grids: Grid[] = [];
  try {
    for (const step of script()) {
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

describe('full-screen frames', () => {
  it('draws the same grid twice for the same script', async () => {
    // Determinism, not parity. An unordered iteration in a paint path or a
    // clock read inside a style decision produces a frame that differs between
    // runs while every content assertion still passes.
    const first = await drive();
    const second = await drive();
    expect(second).toHaveLength(first.length);
    for (let frame = 0; frame < first.length; frame += 1) {
      expect(gridDiff(first[frame] as Grid, second[frame] as Grid), `frame ${frame + 1}`).toBe('');
    }
  });

  it('actually painted something, so the gate cannot pass vacuously', async () => {
    const [first] = await drive();
    const painted = (first ?? []).some((row) => row.some((cell) => cell !== ' '));
    expect(painted).toBe(true);
  });

  it('keeps the transcript line the script wrote on screen', async () => {
    const grids = await drive();
    const flat = (grids[0] ?? []).map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
    expect(flat).toContain('Line one of the transcript.');
  });

  it('draws the inline-Markdown frame, so the corpus is not a no-op', async () => {
    const grids = await drive();
    const last = (grids.at(-1) ?? []).map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
    expect(last).toContain('em');
    expect(last).not.toContain('{');
    expect(last).toContain('docs');
    expect(last).toContain('[image]');
  });
});

/** Drive one step and return the screen it produced. */
async function driveOnce(step: Step): Promise<Grid> {
  const { surface, output } = makeSurface();
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

describe('span rows and tag rows agree (plan 615 Phase 5, still load-bearing)', () => {
  /** The same content, as spans. */
  const SPANS = [
    [{ text: 'plain ' }, { text: 'muted', fg: { kind: 'named' as const, name: 'gray' } }],
    [{ text: 'bold', attrs: ['bold' as const] }, { text: ' then muted', fg: { kind: 'named' as const, name: 'gray' } }],
    [{ text: '中文与 ascii 混排' }],
    [{ text: 'indexed', fg: { kind: 'indexed' as const, index: 241 } }],
  ];

  it('paints the spans and their tag spelling onto the same cells', async () => {
    // One renderer, two input spellings. `spansToTags` is the inverse view the
    // transcript still emits, so the two paths meeting on the same cells is what
    // keeps a block migrated to spans from changing the screen — including where
    // a line wraps. With one renderer this is no longer about parity between
    // implementations; it is about two representations of one frame.
    const VIEW = tagViewOf(stylesOf({ renderer: 'own' }));
    const spanned = await driveOnce({ transcript: { lines: SPANS, height: 8 } });
    const tagged = await driveOnce({
      transcript: { lines: SPANS.map((line) => spansToTags(line, VIEW)), height: 8 },
    });

    expect(gridDiff(tagged, spanned)).toBe('');
  });

  it('is not vacuous: the frame actually contains the text', async () => {
    const grid = await driveOnce({ transcript: { lines: SPANS, height: 8 } });
    const flat = grid.map((row) => row.join('').replace(/\u0000/g, '')).join('\n');
    expect(flat).toContain('plain muted');
    expect(flat).toContain('中文与 ascii 混排');
    expect(flat).not.toContain('{');
  });
});

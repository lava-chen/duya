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
    for (const step of SCRIPT) {
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

describe('render parity (blessed vs own)', () => {
  it('draws the same glyphs for every frame of the script', async () => {
    const blessedGrids = await drive('blessed');
    const ownGrids = await drive('own');
    expect(blessedGrids).toHaveLength(SCRIPT.length);
    expect(ownGrids).toHaveLength(SCRIPT.length);

    for (let frame = 0; frame < SCRIPT.length; frame += 1) {
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
});

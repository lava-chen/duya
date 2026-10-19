import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BlessedProgram } from 'blessed';

import { OwnScreenSurface } from '../screen/own/surface.js';

function makeSurface(unicodeBox = true) {
  let outputText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += Buffer.from(chunk).toString('utf8');
      callback();
    },
  });
  const program = {
    enableMouse() {},
  } as unknown as BlessedProgram;
  const surface = new OwnScreenSurface({
    program,
    output,
    getSize: () => ({ columns: 80, rows: 24 }),
    statusRows: 1,
    overlayWidth: '70%',
    unicodeBox,
  });
  return { surface, outputText: () => outputText };
}

/**
 * Let a queued frame compose.
 *
 * `render()` coalesces onto the microtask queue the way blessed buffers onto
 * `nextTick`, so a frame requested in this tick is not readable until the tick
 * ends. Asserting straight after `render()` reads the PREVIOUS frame — which is
 * exactly the stale-state class of bug the coalescing exists to prevent.
 */
const flushed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('OwnScreenSurface', () => {
  it('lays out the composer and draws styled CJK text into the owned grid', async () => {
    const { surface, outputText } = makeSurface();
    surface.attachAll();
    surface.update('input', { lines: ['{cyan-fg}你好{/cyan-fg}duya'], height: 3 });
    surface.render();
    await flushed();

    const input = surface.measure('input');
    // `innerWidth`/`innerHeight` are blessed's `iwidth`/`iheight`: the space
    // the border consumes, not what is left inside it. The content box is
    // `width - innerWidth`, which is what the painter draws into.
    expect(input).toMatchObject({
      left: 0,
      top: 20,
      width: 80,
      height: 3,
      innerLeft: 1,
      innerTop: 1,
      innerWidth: 2,
      innerHeight: 2,
      laidOut: true,
    });
    expect(outputText()).toContain('\u001b[36m你好\u001b[mduya');
    expect(outputText()).toContain('─');
    surface.destroy();
  });

  it('centres the overlay and redraws only rows whose cells changed', async () => {
    const { surface, outputText } = makeSurface();
    surface.attachAll();
    surface.update('overlay', {
      lines: ['choose'],
      height: 7,
      borderColor: 'yellow',
      hidden: false,
    });
    surface.render();
    await flushed();

    expect(surface.measure('overlay')).toMatchObject({
      left: 12,
      top: 9,
      width: 56,
      height: 7,
      laidOut: true,
    });
    expect(outputText()).toContain('┌');
    expect(outputText()).toContain('choose');

    const afterFirstFrame = outputText().length;
    surface.render();
    await flushed();
    expect(outputText()).toHaveLength(afterFirstFrame);

    surface.update('status', { lines: ['ready'] });
    surface.render();
    await flushed();
    const statusDelta = outputText().slice(afterFirstFrame);
    expect(statusDelta.match(/\u001b\[\d+;1H/g)).toEqual(['\u001b[24;1H']);
    expect(statusDelta).toContain('ready');
    surface.destroy();
  });

  it('uses ASCII borders when the terminal reports no box-drawing support', async () => {
    const { surface, outputText } = makeSurface(false);
    surface.attachAll();
    surface.update('overlay', { lines: ['choose'], height: 5, hidden: false });
    surface.render();
    await flushed();

    expect(outputText()).toContain('+');
    expect(outputText()).toContain('-');
    expect(outputText()).not.toMatch(/[┌┐└┘─│]/);
    surface.destroy();
  });
});

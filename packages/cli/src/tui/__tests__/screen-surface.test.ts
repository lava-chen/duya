/**
 * The drawing seam itself.
 *
 * There is one implementation now (plan 615 Phase 7 retired the blessed one),
 * so this file no longer compares two renderers. What it still does is state the
 * CONTRACT: five named regions, patches that omit rather than reset, border cost
 * reported separately from content size, lazy construction. Those are the
 * promises `TUIApp`'s paint methods are written against, and they are worth
 * asserting directly — a regression here shows up as a misplaced box, not as a
 * failed expectation somewhere downstream.
 *
 * The alt-buffer rules are the load-bearing ones. Inline mode exists because
 * raising the alternate buffer is irreversible for the rest of the frame, so
 * "does not enter it until asked" is a behavioural requirement, not an
 * implementation detail.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'stream';

import { createScreenSurface } from '../screen/index.js';
import type { RegionPatch, SurfaceRegion } from '../screen/types.js';

function makeStream() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns: number; rows: number };
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function makeSurface(options: { attach?: boolean } = {}) {
  const output = makeStream();
  const surface = createScreenSurface({
    statusRows: 1,
    overlayWidth: '70%',
    output: output.stream,
    getSize: () => ({ columns: output.stream.columns, rows: output.stream.rows }),
    unicodeBox: true,
  });
  if (options.attach === true) surface.attachAll();
  return { surface, output };
}

/** The surface defers its write to a microtask; a tick is enough to observe it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('renderer selection', () => {
  it('has exactly one renderer, and a stale DUYA_TUI_RENDERER cannot bring back another', () => {
    // The env var was the rollback switch for the blessed path. Someone with it
    // still in a shell profile must get the working renderer, not a crash —
    // this asserts the value is ignored rather than honoured.
    const original = process.env['DUYA_TUI_RENDERER'];
    process.env['DUYA_TUI_RENDERER'] = 'blessed';
    try {
      const { surface } = makeSurface();
      expect(surface.constructor.name).toBe('OwnScreenSurface');
      surface.destroy();
    } finally {
      if (original === undefined) delete process.env['DUYA_TUI_RENDERER'];
      else process.env['DUYA_TUI_RENDERER'] = original;
    }
  });
});

describe('screen surface lifecycle', () => {
  it('reports ready only once a screen exists', () => {
    const { surface } = makeSurface();
    expect(surface.ready).toBe(false);
    surface.ensure();
    expect(surface.ready).toBe(true);
    surface.destroy();
    expect(surface.ready).toBe(false);
  });

  it('builds nothing until asked, and never enters the alternate buffer early', async () => {
    // The whole reason inline mode can exist: raising the alternate buffer is a
    // side effect that cannot be undone mid-frame, so building one eagerly would
    // put the conversation behind a buffer it cannot leave.
    const { surface, output } = makeSurface();
    await settle();
    expect(output.text()).not.toContain('\x1b[?1049h');
    surface.ensure();
    await settle();
    expect(output.text()).toContain('\x1b[?1049h');
    surface.destroy();
  });

  it('is safe to render, measure and update before a screen exists', () => {
    const { surface } = makeSurface();
    expect(() => surface.render()).not.toThrow();
    expect(surface.measure('transcript')).toBeNull();
    expect(surface.content('transcript')).toEqual([]);
  });

  it('creates only the overlay when built lazily, and all five when attached', () => {
    const lazy = makeSurface();
    lazy.surface.update('overlay', { lines: ['hello'] });
    expect(lazy.surface.measure('overlay')).not.toBeNull();
    // A lazily built screen exists for the overlay alone; the transcript was
    // never attached and asking for it must not conjure one.
    expect(lazy.surface.measure('transcript')).toBeNull();

    const eager = makeSurface({ attach: true });
    for (const region of ['transcript', 'input', 'status', 'overlay', 'completion'] as const) {
      expect(eager.surface.measure(region), region).not.toBeNull();
    }
  });
});

describe('screen surface regions', () => {
  it('applies each patch field and records the content it was given', () => {
    const { surface } = makeSurface({ attach: true });
    const patch: RegionPatch = { lines: ['one', 'two'], height: 5, bottom: 3, borderColor: 'cyan' };
    surface.update('completion', patch);
    expect(surface.content('completion')).toEqual(['one', 'two']);
    expect(surface.measure('completion')?.height).toBe(5);
  });

  it('treats an absent field as "leave it alone", not as a reset', () => {
    // The paint methods set a region's height on some frames and its content on
    // every frame. Reading an omission as a reset would blank the region.
    const { surface } = makeSurface({ attach: true });
    surface.update('status', { lines: ['ready'], height: 1 });
    surface.update('status', { borderColor: 'gray' });
    expect(surface.content('status')).toEqual(['ready']);
    expect(surface.measure('status')?.height).toBe(1);
  });

  it('reports the border cost, not the content size, in innerWidth/innerHeight', async () => {
    // The region metrics name what the BORDER consumes. Callers derive the
    // content box as `width - innerWidth`, so a renderer that reported the
    // content size instead would clip typed text on every framed region — and
    // look correct on borderless ones, where both readings are 0.
    const { surface } = makeSurface({ attach: true });
    surface.update('input', { lines: ['x'], height: 3 });
    // `laidOut` is false until the renderer has actually placed the region, and
    // the cursor routine depends on that distinction: "created" is not "placed".
    expect(surface.measure('input')?.laidOut).toBe(false);
    surface.render();
    await settle();

    const framed = surface.measure('input');
    expect(framed?.laidOut).toBe(true);
    expect(framed?.innerWidth).toBe(2);
    expect(framed?.innerHeight).toBe(2);

    surface.update('input', { borderStyle: 'none' });
    surface.render();
    await settle();
    const bare = surface.measure('input');
    expect(bare?.innerWidth).toBe(0);
    expect(bare?.innerHeight).toBe(0);
    surface.destroy();
  });

  it('hides and shows without giving up the region', () => {
    const { surface } = makeSurface({ attach: true });
    surface.update('completion', { lines: ['a'], hidden: true });
    expect(surface.content('completion')).toEqual(['a']);
    expect(surface.measure('completion')).not.toBeNull();
    surface.update('completion', { hidden: false });
    expect(surface.measure('completion')).not.toBeNull();
  });

  it('drops remembered content when the surface is destroyed', () => {
    // A stale answer here would be worse than none: it would describe a screen
    // that no longer exists.
    const { surface } = makeSurface({ attach: true });
    surface.update('overlay', { lines: ['ask'] });
    surface.destroy();
    expect(surface.content('overlay')).toEqual([]);
    expect(surface.measure('overlay')).toBeNull();
  });

  it('covers every region the interface declares', () => {
    // A region added to the type but not to the geometry table would be
    // silently undrawable. Both lists are named here so the failure is loud.
    const regions: SurfaceRegion[] = ['transcript', 'input', 'status', 'overlay', 'completion'];
    const { surface } = makeSurface({ attach: true });
    for (const region of regions) {
      surface.update(region, { lines: ['x'] });
      expect(surface.content(region), region).toEqual(['x']);
    }
  });
});

describe('alt-buffer suspension', () => {
  it('stops painting while suspended and resumes on enter', async () => {
    const { surface, output } = makeSurface({ attach: true });
    surface.update('overlay', { lines: ['ask'], hidden: false });
    surface.render();
    await settle();

    surface.leave();
    await settle();
    expect(surface.suspended).toBe(true);
    // Measured AFTER leaving, because leaving legitimately emits the
    // alternate-buffer exit sequence. What must not happen is any further
    // painting: a buffered screen would draw over the normal conversation
    // underneath it.
    const afterLeave = output.text().length;
    surface.update('overlay', { lines: ['changed'] });
    surface.render();
    await settle();
    expect(output.text().length).toBe(afterLeave);

    surface.enter();
    await settle();
    expect(surface.suspended).toBe(false);
    surface.render();
    await settle();
    expect(output.text().length).toBeGreaterThan(afterLeave);
    surface.destroy();
  });

  it('treats enter and leave as idempotent, and never re-enters the buffer twice', async () => {
    const { surface, output } = makeSurface({ attach: true });
    surface.render();
    await settle();
    const enters = (): number => output.text().split('\x1b[?1049h').length - 1;
    // `attachAll` raised the buffer once. A second `enter()` while already in it
    // would raise it again, which clears the screen the user is reading.
    expect(enters()).toBe(1);
    surface.enter();
    expect(enters()).toBe(1);

    surface.leave();
    await settle();
    expect(surface.suspended).toBe(true);
    // Leaving and coming back is legitimate and must re-enter exactly once; the
    // pair of `enter()` calls that follows must not add a third.
    surface.enter();
    surface.enter();
    expect(surface.suspended).toBe(false);
    expect(enters()).toBe(2);
    surface.destroy();
  });
});

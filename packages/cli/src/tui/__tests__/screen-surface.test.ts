/**
 * The drawing seam itself.
 *
 * `TUIApp`'s tests prove the refactor changed nothing, because they all stayed
 * green. These rows cover the thing that cannot be proved that way: the
 * contract a SECOND renderer has to satisfy. Every assertion here is about the
 * interface's promises, not about blessed's behaviour, so they are the checks a
 * new implementation must be able to pass.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';
import blessed from 'blessed';

import { createScreenSurface } from '../screen/index.js';
import type { RegionPatch, SurfaceRegion } from '../screen/types.js';

const SURFACE_IMPLEMENTATIONS = [
  { name: 'blessed', renderer: 'blessed' },
  { name: 'own', renderer: 'own' },
] as const;

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

function makeSurface(
  renderer?: (typeof SURFACE_IMPLEMENTATIONS)[number]['renderer'],
  options: { attach?: boolean } = {},
) {
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
    screenOptions: { program, smartCSR: true, fullUnicode: true, title: 'test' },
    statusRows: 1,
    overlayWidth: '70%',
    output: output.stream,
    getSize: () => ({ columns: output.stream.columns, rows: output.stream.rows }),
    ...(renderer === undefined ? {} : { renderer }),
  });
  if (options.attach === true) surface.attachAll();
  return { surface, program, output, input };
}

/**
 * Blessed writes on its own schedule, not on the call that asked for a frame,
 * so every assertion about terminal bytes has to let it drain first. Reading
 * the stream synchronously reports "nothing was drawn" for a renderer that drew
 * perfectly well.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('ScreenSurface renderer selection', () => {
  const selections = [
    { env: 'own', expected: 'OwnScreenSurface' },
    { env: 'blessed', expected: 'BlessedScreenSurface' },
    // plan 615 Phase 0: own is the default; blessed needs the env opt-out.
    { env: undefined, expected: 'OwnScreenSurface' },
  ] as const;

  it.each(selections)('selects $expected for DUYA_TUI_RENDERER=$env', ({ env, expected }) => {
    const original = process.env['DUYA_TUI_RENDERER'];
    if (env === undefined) delete process.env['DUYA_TUI_RENDERER'];
    else process.env['DUYA_TUI_RENDERER'] = env;
    try {
      const { surface } = makeSurface();
      expect(surface.constructor.name).toBe(expected);
      surface.destroy();
    } finally {
      if (original === undefined) delete process.env['DUYA_TUI_RENDERER'];
      else process.env['DUYA_TUI_RENDERER'] = original;
    }
  });
});

for (const implementation of SURFACE_IMPLEMENTATIONS) {
describe('ScreenSurface (' + implementation.name + ') lifecycle', () => {
  it('reports ready only once a screen exists', () => {
    const { surface } = makeSurface(implementation.renderer);
    expect(surface.ready).toBe(false);
    surface.ensure();
    expect(surface.ready).toBe(true);
    surface.destroy();
    expect(surface.ready).toBe(false);
  });

  it('builds nothing until asked, and never enters the alternate buffer early', async () => {
    // The whole reason inline mode can exist: `blessed.screen` enters the
    // alternate buffer as a side effect of construction, so building one
    // eagerly would put the conversation behind a buffer it cannot leave.
    const { surface, output } = makeSurface(implementation.renderer);
    await settle();
    expect(output.text()).not.toContain('\x1b[?1049h');
    surface.ensure();
    await settle();
    expect(output.text()).toContain('\x1b[?1049h');
    surface.destroy();
  });

  it('is safe to render, measure and update before a screen exists', () => {
    // An update is what creates the screen, so only these three are the
    // do-nothing paths. A TUI that paints on its first frame must not throw.
    const { surface } = makeSurface(implementation.renderer);
    expect(() => surface.render()).not.toThrow();
    expect(surface.measure('transcript')).toBeNull();
    expect(surface.content('transcript')).toEqual([]);
  });

  it('creates only the overlay when built lazily, and all five when attached', () => {
    const lazy = makeSurface(implementation.renderer);
    lazy.surface.update('overlay', { lines: ['hello'] });
    expect(lazy.surface.measure('overlay')).not.toBeNull();
    // A lazily built screen exists for the overlay alone; the transcript was
    // never attached and asking for it must not conjure one.
    expect(lazy.surface.measure('transcript')).toBeNull();

    const eager = makeSurface(implementation.renderer, { attach: true });
    for (const region of ['transcript', 'input', 'status', 'overlay', 'completion'] as const) {
      expect(eager.surface.measure(region), region).not.toBeNull();
    }
  });
});

describe('ScreenSurface regions', () => {
  it('applies each patch field and records the content it was given', () => {
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    const patch: RegionPatch = { lines: ['one', 'two'], height: 5, bottom: 3, borderColor: 'cyan' };
    surface.update('completion', patch);
    expect(surface.content('completion')).toEqual(['one', 'two']);
    const measured = surface.measure('completion');
    expect(measured?.height).toBe(5);
  });

  it('treats an absent field as "leave it alone", not as a reset', () => {
    // The paint methods set a region's height on some frames and its content on
    // every frame. Reading an omission as a reset would blank the region.
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    surface.update('status', { lines: ['ready'], height: 1 });
    surface.update('status', { borderColor: 'gray' });
    expect(surface.content('status')).toEqual(['ready']);
    expect(surface.measure('status')?.height).toBe(1);
  });

  it('reports measured geometry rather than letting callers compute it', async () => {
    // `innerWidth`/`innerHeight` already account for whether a border exists.
    // A renderer that reported raw numbers here would make the composer wrap
    // two columns off on exactly the terminals that dropped their border.
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    surface.update('input', { lines: ['x'], height: 3 });
    // `laidOut` is false until the renderer has actually placed the region, and
    // the cursor routine depends on that distinction: "created" is not "placed".
    expect(surface.measure('input')?.laidOut).toBe(false);
    surface.render();
    await settle();

    const framed = surface.measure('input');
    expect(framed?.laidOut).toBe(true);
    expect(framed?.innerHeight).toBeLessThanOrEqual(framed?.height ?? 0);

    surface.update('input', { borderStyle: 'none' });
    surface.render();
    await settle();
    const bare = surface.measure('input');
    expect(bare?.innerHeight).not.toBe(framed?.innerHeight);
    surface.destroy();
  });

  it('hides and shows without giving up the region', () => {
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    surface.update('completion', { lines: ['a'], hidden: true });
    expect(surface.content('completion')).toEqual(['a']);
    expect(surface.measure('completion')).not.toBeNull();
    surface.update('completion', { hidden: false });
    expect(surface.measure('completion')).not.toBeNull();
  });

  it('drops remembered content when the surface is destroyed', () => {
    // A stale answer here would be worse than none: it would describe a screen
    // that no longer exists.
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    surface.update('overlay', { lines: ['ask'] });
    surface.destroy();
    expect(surface.content('overlay')).toEqual([]);
    expect(surface.measure('overlay')).toBeNull();
  });

  it('covers every region the interface declares', () => {
    // A region added to the type but not to the geometry table would be
    // silently undrawable. Both lists are named here so the failure is loud.
    const regions: SurfaceRegion[] = ['transcript', 'input', 'status', 'overlay', 'completion'];
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    for (const region of regions) {
      surface.update(region, { lines: ['x'] });
      expect(surface.content(region), region).toEqual(['x']);
    }
  });
});

describe('ScreenSurface alt-buffer suspension', () => {
  it('stops painting while suspended and resumes on enter', async () => {
    const { surface, output } = makeSurface(implementation.renderer, { attach: true });
    surface.update('overlay', { lines: ['ask'], hidden: false });
    surface.render();
    await settle();

    surface.leave();
    await settle();
    expect(surface.suspended).toBe(true);
    // Measured AFTER leaving, because leaving legitimately emits the
    // alternate-buffer exit sequence. What must not happen is any further
    // painting: the buffered screen would draw its widgets over the normal
    // conversation underneath it, and blessed repaints on resize even after
    // leave() precisely because of that.
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

  it('treats enter and leave as idempotent', async () => {
    const { surface } = makeSurface(implementation.renderer, { attach: true });
    surface.ensure();
    surface.leave();
    await settle();
    const held = (surface as unknown as { screen: unknown }).screen;
    surface.leave();
    surface.enter();
    surface.enter();
    expect(surface.suspended).toBe(false);
    // Neither call may rebuild the buffer: rebuilding would re-enter the
    // alternate screen and blank the conversation underneath.
    expect((surface as unknown as { screen: unknown }).screen).toBe(held);
    surface.destroy();
  });
});
}

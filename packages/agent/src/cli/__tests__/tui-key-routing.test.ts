import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../ui/TUIApp.js';

/**
 * Enter submits, driven by real bytes.
 *
 * ## Why this exists
 *
 * `bindKeys()` mixes two dispatch paths that blessed keeps apart:
 *
 * - `screen.on('keypress', ...)` is a listener on the Screen ELEMENT, fired by
 *   Screen's own handler (`blessed/lib/widgets/screen.js:592`);
 * - `screen.key(...)` is not an element listener at all. `Screen.prototype.key`
 *   forwards to `program.key` (`blessed/lib/widgets/screen.js:1726`), which
 *   registers on the PROGRAM emitter under `'key <name>'`
 *   (`blessed/lib/program.js:515-520`) and is fed by a separate broadcast in
 *   `Program._listenInput` (`program.js:408-412`).
 *
 * The two paths have different owners and different guards, so a key bound
 * through one of them can be dead while the other works — which is exactly the
 * shape of "typing works but Enter does nothing". Reading the code cannot
 * settle it, so this drives the actual bytes through a real input stream.
 */

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TUIApp key routing', () => {
  it('submits the typed prompt when Enter arrives', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    input.write('hi');
    await settle();
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['hi']);
    app.stop();
  });

  it('submits a slash command typed as a whole word', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    input.write('/help');
    await settle();
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['/help']);
    app.stop();
  });

  it('does not submit on Enter when the input is empty', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    input.write('\r');
    await settle();

    expect(submitted).toEqual([]);
    app.stop();
  });
});
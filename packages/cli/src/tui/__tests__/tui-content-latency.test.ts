/**
 * How fast NEW CONTENT reaches the screen.
 *
 * ## What this pins down
 *
 * The render throttle is trailing-edge, so content that arrives just after a
 * frame waits for the rest of the throttle window before it is painted. For
 * the FIRST token of an answer that window was opened by a frame which did
 * not contain the token, so the user waits for a frame that shows nothing
 * they have not already seen — on the one moment they are watching hardest.
 *
 * So the first content of a burst is painted on the spot, and everything
 * after it stays on the trailing throttle.
 *
 * ## Why these assertions are about BEHAVIOUR, not time
 *
 * No wall-clock threshold appears here: a shared CI box makes those a false
 * red waiting to happen. What is asserted is that the content is in the frame
 * that follows it, that a burst costs a bounded number of frames rather than
 * one per token, and that the tail of the burst still reaches the screen.
 */

import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

/** The marker every full-screen frame opens with. */
const SYNC_BEGIN = '[?2026h';

function sink(): { stream: Writable; chunks: Buffer[]; text: () => string; reset: () => void } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    stream,
    chunks,
    text: () => Buffer.concat(chunks).toString('utf8'),
    reset: () => {
      chunks.length = 0;
    },
  };
}

/** Let the renderer's deferred write reach the stream. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Long enough for a throttled frame to have been scheduled and flushed. */
async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS * 4));
  await settle();
}

/** How many frames the output carries. */
function countFrames(text: string): number {
  return text.split(SYNC_BEGIN).length - 1;
}

function startApp(out: ReturnType<typeof sink>): TUIApp {
  const app = new TUIApp({
    output: out.stream,
    input: new PassThrough(),
    onSubmit: () => {},
  });
  app.start();
  return app;
}

describe('TUIApp new content', () => {
  it('paints the first content of a turn without waiting for the throttle window', async () => {
    const out = sink();
    const app = startApp(out);
    await settle();
    out.reset();

    // A single delta, with no newline: the delta buffer's line quantisation
    // would otherwise hold it until it goes stale, and the throttle would
    // hold the frame that shows it.
    app.push({ type: 'text_delta', data: { content: 'FIRST_TOKEN' } });
    await settle();

    // The frame that follows the first content carries the content. This is
    // the assertion the whole change exists for: before it, the frame was up
    // to a full throttle window away and showed nothing new.
    expect(out.text()).toContain('FIRST_TOKEN');
    app.stop();
  });

  it('coalesces a burst of deltas into a bounded number of frames', async () => {
    const out = sink();
    const app = startApp(out);
    await settle();
    out.reset();

    const deltas = 200;
    for (let index = 0; index < deltas; index += 1) {
      app.push({ type: 'text_delta', data: { content: `tok-${String(index)} ` } });
    }
    await settle();

    // One leading frame for the burst, NOT one frame per token. The bound is
    // loose on purpose: a slow machine may let one trailing frame through.
    expect(countFrames(out.text())).toBeLessThanOrEqual(2);
    expect(countFrames(out.text())).toBeLessThan(deltas);
    app.stop();
  });

  it('still paints the tail of a burst', async () => {
    const out = sink();
    const app = startApp(out);
    await settle();
    out.reset();

    const deltas = 60;
    for (let index = 0; index < deltas; index += 1) {
      app.push({ type: 'text_delta', data: { content: `line-${String(index).padStart(3, '0')}\n` } });
    }
    await settleRendered();

    // The leading edge must not become the leading-edge throttle this file's
    // siblings warn about: the last line of the burst still has to arrive.
    expect(out.text()).toContain(`line-${String(deltas - 1).padStart(3, '0')}`);
    app.stop();
  });
});

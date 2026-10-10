import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../ui/TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../ui/render-scheduler.js';

/**
 * Tail-follow under a coalesced burst.
 *
 * ## Why this guard is shaped the way it is
 *
 * The defect it pins down was invisible to a test that awaits between frames:
 * with a settle after every delta, each render measures a one-line change and
 * the view tracks the content closely enough that the tail is on screen. The
 * bug only appears when deltas arrive faster than `MIN_RENDER_INTERVAL_MS`, so
 * the render throttle coalesces several into one frame — which is precisely
 * what a streaming answer does over a real socket.
 *
 * So this pushes the burst WITHOUT awaiting, then asserts on what the last
 * painted frame actually contains. A guard that only exercises the paced path
 * would pass against the broken implementation.
 */

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Long enough for a throttled render to have been scheduled and flushed. */
async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS * 4));
  await settle();
}

const BURST_LINES = 60;

describe('TUIApp tail-follow', () => {
  it('shows the newest line when a burst of deltas is coalesced into one frame', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      onSubmit: () => {},
    });
    app.start();
    await settle();

    // No await inside the loop: every delta lands inside one throttle window.
    for (let i = 0; i < BURST_LINES; i += 1) {
      app.push({ type: 'text_delta', data: { content: `line-${String(i).padStart(3, '0')}\n` } });
    }
    app.setBusy(false);
    await settleRendered();

    const painted = out.text();
    // The tail is what the user is waiting for. Asserting on the HEAD would
    // pass even while the newest content sits below the fold.
    expect(painted).toContain(`line-${String(BURST_LINES - 1).padStart(3, '0')}`);
    app.stop();
  });

  it('scrolls back to older lines on pageup and returns to following on pagedown', async () => {
    const out = sink();
    const input = new PassThrough();
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: () => {},
    });
    app.start();
    await settle();

    for (let i = 0; i < BURST_LINES; i += 1) {
      app.push({ type: 'text_delta', data: { content: `line-${String(i).padStart(3, '0')}\n` } });
    }
    await settleRendered();
    expect(app.renderState.follow).toBe(true);

    // Scrolling back has to move the window onto lines that were dropped from
    // the top, so the newly-visible text has to be written to the terminal.
    out.reset();
    input.write('\x1b[5~'); // pageup
    await settleRendered();
    const scrolledBack = out.text();
    expect(scrolledBack).toContain('line-0');
    expect(app.renderState.follow).toBe(false);

    // Scrolling forward to the newest line re-engages following.
    input.write('\x1b[6~'); // pagedown
    await settleRendered();
    expect(app.renderState.follow).toBe(true);
    app.stop();
  });
});
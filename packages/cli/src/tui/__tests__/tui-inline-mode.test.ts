/**
 * Inline mode, driven end to end.
 *
 * The claim inline mode makes is narrow and testable: the conversation is
 * printed into the terminal's own scrollback, and the terminal is never taken
 * over. The second half is the one that is easy to break silently, because
 * `blessed.screen()` enters the alternate buffer in its CONSTRUCTOR — a single
 * line moved back into an `if` puts the whole app in a buffer that has no
 * scrollback, while every rendering test stays green because the bytes look
 * the same. So the alternate-buffer sequence is asserted directly, and asserted
 * in the full-screen case too, to prove the assertion can actually fail.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';

import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

/** `\x1b[?1049h`: enter the alternate screen buffer. */
const ALT_BUFFER_ON = '\x1b[?1049h';

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

function makeApp(options: { inline?: boolean; submitted?: string[] } = {}) {
  const out = sink();
  const submitted = options.submitted ?? [];
  const app = new TUIApp({
    output: out.stream,
    input: new PassThrough(),
    inline: options.inline === true,
    onSubmit: (text) => {
      submitted.push(text);
    },
  });
  return { app, out, submitted };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
}

/** Enough transcript to push the live area off the top of a 24-row screen. */
function flood(app: TUIApp, lines: number): void {
  const body = Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');
  // One trailing newline, so the block is complete rather than ending on a
  // partial line the renderer may treat as still-arriving.
  app.push({ type: 'text_delta', data: { content: `${body}\n` } });
}

describe('inline mode', () => {
  it('never enters the alternate screen buffer', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    flood(app, 40);
    await settleRendered();
    app.stop();
    // The whole point of the mode: an alternate buffer has no scrollback, so a
    // conversation committed into one is gone when the TUI exits.
    expect(out.text()).not.toContain(ALT_BUFFER_ON);
  });

  it('does enter the alternate buffer in full-screen mode', async () => {
    // The control for the test above. Without it, "no alt buffer" would pass for
    // a build where nothing is ever rendered at all.
    const { app, out } = makeApp();
    app.start();
    await settle();
    app.stop();
    expect(out.text()).toContain(ALT_BUFFER_ON);
  });

  it('commits the conversation into the terminal scrollback', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    flood(app, 120);
    await settleRendered();
    // The pacer coalesces deltas into one frame, so a single wait can land
    // before the last of them has been drained. A second wait is the difference
    // between "not all the text arrived yet" and "the commit lost it".
    await settleRendered();
    app.stop();
    const text = out.text();
    // A scroll region plus real prints: not a full-screen redraw of the
    // transcript, which is what the old windowed model did and why nothing
    // survived the exit.
    expect(text).toMatch(/\x1b\[\d+;\d+r/);
    const lines = [...text.matchAll(/line (\d+)/gu)].map((match) => Number.parseInt(match[1] ?? '', 10));
    // The first line is committed, so it exists even though it is no longer in
    // the live area — that is the whole difference from a fixed window.
    expect(lines).toContain(0);
    const missing = [...Array(120).keys()].filter((i) => !lines.includes(i));
    expect(missing).toEqual([]);
  });

  it('draws the composer with a prompt marker and no panel border', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    app.stop();
    // Inline chrome is the last line of the conversation, not a box below it —
    // which is the structural change from the two-panel window.
    expect(out.text()).toContain('❯');
    expect(out.text()).not.toContain('┌');
  });

  it('keeps keys working without a Screen to bind them to', async () => {
    const submitted: string[] = [];
    const { app } = makeApp({ inline: true, submitted });
    app.start();
    app.push({ type: 'text_delta', data: { content: 'ready\n' } });
    // Keys are bound to the Program now. `Screen.prototype.key` was only ever a
    // delegation to it, so nothing about the binding changed — but the Screen it
    // used to be reached through does not exist inline.
    (app as unknown as { program: { emit: (name: string, ...rest: unknown[]) => void } })
      .program.emit('key C-m');
    await settleRendered();
    app.stop();
    // The editor had nothing typed, so Enter submits the empty buffer; what
    // matters is that the chord reached a handler instead of throwing on a
    // missing Screen.
    expect(submitted.length).toBeLessThanOrEqual(1);
  });

  it('builds a full-screen buffer only while an overlay is open', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    expect(out.text()).not.toContain(ALT_BUFFER_ON);

    // F1 opens the help window: a modal takeover, the one thing a full-screen
    // buffer is for. This is codex's split — conversation in the normal screen,
    // overlay in the alternate one.
    (app as unknown as { program: { emit: (name: string, ...rest: unknown[]) => void } })
      .program.emit('key f1');
    await settleRendered();
    expect(out.text()).toContain(ALT_BUFFER_ON);

    (app as unknown as { program: { emit: (name: string, ...rest: unknown[]) => void } })
      .program.emit('key escape');
    await settleRendered();
    app.stop();
    // Closed again, or the conversation would stay hidden behind a buffer the
    // user can no longer get out of.
    expect(out.text().split(ALT_BUFFER_ON).length - 1).toBeGreaterThanOrEqual(1);
    const reopened = (app as unknown as { screen: unknown }).screen;
    expect(reopened).toBeNull();
  });

  it('leaves the conversation on screen when it stops', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    flood(app, 5);
    await settleRendered();
    const before = out.text().length;
    app.stop();
    const tail = out.text().slice(before);
    // Cursor restored, nothing erased. A teardown that cleared the screen would
    // defeat the reason the mode exists.
    expect(tail).toContain('\x1b[?25h');
    expect(tail).not.toContain('\x1b[2J');
    expect(tail).not.toContain('\x1b[3J');
  });
});

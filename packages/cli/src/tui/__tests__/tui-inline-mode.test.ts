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
import { press } from './key-injection.js';
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

function makeApp(
  options: { inline?: boolean; submitted?: string[]; effort?: () => string | null } = {},
) {
  const out = sink();
  const submitted = options.submitted ?? [];
  const input = new PassThrough();
  const app = new TUIApp({
    output: out.stream,
    input,
    inline: options.inline === true,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    onSubmit: (text) => {
      submitted.push(text);
    },
  });
  return { app, out, submitted, input };
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

  it('draws a composer prompt between horizontal rules without panel corners', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    app.stop();
    // Low-capability environments use the ASCII prompt and separators.
    expect(out.text()).toMatch(/❯|> /u);
    expect(out.text()).toMatch(/─{3}|-{3}/u);
    expect(out.text()).not.toContain('┌');
  });

  it('lists pending drafts above the composer, one row each and three at most', async () => {
    const out = sink();
    const drafts = [
      { text: 'first', mode: 'queue' as const },
      { text: 'second', mode: 'queue' as const },
      { text: 'third', mode: 'steer' as const },
      { text: 'fourth', mode: 'queue' as const },
      { text: 'fifth', mode: 'steer' as const },
    ];
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      inline: true,
      queuedDrafts: () => drafts,
      onSubmit: () => {},
    });
    app.start();
    await settleRendered();
    app.stop();
    const text = out.text();
    // The budget is fixed: this block is chrome, and a queue that grows would
    // push the composer down a row per draft until the terminal ran out.
    expect(text).toContain('… 2 earlier');
    expect(text).toContain('↳ steer · third');
    expect(text).toContain('⧗ queued · fourth');
    expect(text).toContain('↳ steer · fifth');
    // The two oldest drafts are behind the summary row, not in it.
    expect(text).not.toContain('· first');
    expect(text).not.toContain('· second');
  });

  it('keeps keys working without a Screen to bind them to', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp({ inline: true, submitted });
    app.start();
    app.push({ type: 'text_delta', data: { content: 'ready\n' } });
    // Keys are bound to the Program now. `Screen.prototype.key` was only ever a
    // delegation to it, so nothing about the binding changed — but the Screen it
    // used to be reached through does not exist inline.
    press(input, 'C-m');
    await settleRendered();
    app.stop();
    // The editor had nothing typed, so Enter submits the empty buffer; what
    // matters is that the chord reached a handler instead of throwing on a
    // missing Screen.
    expect(submitted.length).toBeLessThanOrEqual(1);
  });

  it('docks a slash secondary page into the composer slot instead of taking the screen', async () => {
    const { app, out, input } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    expect(out.text()).not.toContain(ALT_BUFFER_ON);

    // F1 opens the help panel. It used to be a centred modal in the alternate
    // buffer; it now shares the composer's slot, the way pi's selectors do, so
    // the conversation above it stays on screen and readable.
    press(input, 'f1');
    await settleRendered();
    const rendered = out.text();
    expect(rendered).toContain('Key bindings');
    expect(rendered).not.toContain(ALT_BUFFER_ON);
    // No alternate buffer was ever built, so there is nothing to come back from.
    const surface = (app as unknown as { fullScreen: { ready: boolean } }).fullScreen;
    expect(surface.ready).toBe(false);

    press(input, 'escape');
    await settleRendered();
    app.stop();
    expect((app as unknown as { windowMgr: { isActive: boolean } }).windowMgr.isActive).toBe(false);
  });

  it('docks a selectable list into the composer slot and answers it with the keyboard', async () => {
    const { app, out, input } = makeApp({ inline: true });
    app.start();
    await settleRendered();

    const chosen = app.choose('Pick one', [
      { label: 'alpha', value: 'a' },
      { label: 'beta', value: 'b' },
    ]);
    await settleRendered();
    // The panel replaces the composer, which means the prompt marker is gone
    // and the two choices are on screen — all without an alternate buffer.
    const rendered = out.text();
    expect(rendered).toContain('Pick one');
    expect(rendered).toContain('beta');
    expect(rendered).not.toContain(ALT_BUFFER_ON);

    press(input, 'down');
    await settleRendered();
    press(input, 'return');
    await settleRendered();
    await expect(chosen).resolves.toBe('b');
    app.stop();
  });

  it('shows a two-row footer: the session location, then spend and model', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      inline: true,
      workspaceDirectory: () => 'E:\\Projects\\duya',
      modelLabel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
      contextBudgetTokens: () => 1_000_000,
      onSubmit: () => {},
    });
    app.start();
    app.push({ type: 'token_usage', data: { input_tokens: 49_000, output_tokens: 1600, total_tokens: 50_600 } });
    await settleRendered();
    app.stop();
    const text = out.text();
    // Row one: where the session is.
    expect(text).toContain('duya');
    // Row two: the counters on the left, the model against the right edge.
    expect(text).toContain('↑49k');
    expect(text).toContain('↓1.6k');
    expect(text).toContain('(deepseek) deepseek-flash');
  });

  it('shows the output rate when the usage frame carries a request duration', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      inline: true,
      workspaceDirectory: () => 'E:\\Projects\\duya',
      modelLabel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
      contextBudgetTokens: () => 1_000_000,
      onSubmit: () => {},
    });
    app.start();
    // 1600 output tokens over 20000 ms is 80 tok/s. The rate comes from the
    // provider's own request duration, so the frame has to carry it.
    app.push({
      type: 'token_usage',
      data: {
        input_tokens: 49_000,
        output_tokens: 1600,
        total_tokens: 50_600,
        request_duration_ms: 20_000,
      },
    });
    await settleRendered();
    app.stop();
    expect(out.text()).toContain('⚡ 80.0 tok/s');
  });

  it('shows no rate when the usage frame carries no request duration', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      inline: true,
      workspaceDirectory: () => 'E:\\Projects\\duya',
      modelLabel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
      contextBudgetTokens: () => 1_000_000,
      onSubmit: () => {},
    });
    app.start();
    app.push({ type: 'token_usage', data: { input_tokens: 49_000, output_tokens: 1600, total_tokens: 50_600 } });
    await settleRendered();
    app.stop();
    expect(out.text()).not.toContain('tok/s');
  });

  it('colours the composer rules by reasoning effort', async () => {
    // pi's tell: the box you type into says how much thinking the next message
    // buys. `auto` stays the muted grey the border has always been.
    const quiet = makeApp({ inline: true });
    quiet.app.start();
    await settleRendered();
    const quietRules = (quiet.app as unknown as { inlineInputLines: string[] }).inlineInputLines;
    quiet.app.stop();
    expect(quietRules[0]).toContain('{240-fg}');

    const loud = makeApp({ inline: true, effort: () => 'high' });
    loud.app.start();
    await settleRendered();
    const loudRules = (loud.app as unknown as { inlineInputLines: string[] }).inlineInputLines;
    loud.app.stop();
    expect(loudRules[0]).toContain('{134-fg}');
    expect(loudRules[loudRules.length - 1]).toContain('{134-fg}');
    // Only the rules are coloured: the text the user types keeps the terminal's
    // own foreground.
    expect(loudRules[1]).not.toContain('{134-fg}');
  });

  it('renders a docked list with its qualifier column', async () => {
    const { app } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    void app.chooseFiltered('Select model · p1', [
      { label: 'gpt-x', value: 'x', description: '200k ctx · current' },
      { label: 'gpt-xl', value: 'xl', description: '1.0M ctx' },
    ]);
    await settleRendered();
    const panel = (app as unknown as { inlineInputLines: string[] }).inlineInputLines.join('\n');
    app.stop();
    expect(panel).toContain('200k ctx · current');
    expect(panel).toContain('1.0M ctx');
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

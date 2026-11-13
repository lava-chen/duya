/**
 * The submitted prompt band inspired by codex.
 *
 * ## What is being learned
 *
 * Codex paints a prompt the user already sent as a band across the pane with
 * a dim `› ` in front of the text (`history_cell/messages.rs`,
 * `UserHistoryCell`). The live composer remains transparent to the terminal.
 *
 * duya had neither, because its tag vocabulary only ever described a
 * FOREGROUND: `colorFromTagBody` knew `-fg` and nothing else, so there was no
 * way to say "this text sits on a fill". The whole feature therefore starts
 * one layer down, in the colour vocabulary, and the two surfaces are the
 * visible consequence.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the bytes: what the tag parser emits, what the span parser
 * records, what the full-screen painter writes into the grid, what the inline
 * rows carry, and how wide a submitted prompt's band is. They do not prove how
 * a particular terminal paints a background — that is the terminal's business,
 * and the same bytes are what codex asks for.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';

import { renderMarkup } from '../screen/own/markup.js';
import { tagsToSpans } from '../core/tags.js';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript } from '../transcript-view.js';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';
import { visibleWidth } from '../width.js';

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5 };

/** Drop the tags so a layout assertion reads the text a user sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

describe('the background slot', () => {
  it('paints a 256-colour background', () => {
    expect(renderMarkup('{236-bg}AB{/236-bg}')).toBe('\x1b[48;5;236mAB\x1b[m');
  });

  it('shifts a named colour up by ten for the background', () => {
    // `gray` is SGR 90 in the foreground, so it is 100 behind the text.
    expect(renderMarkup('{gray-bg}AB{/gray-bg}')).toBe('\x1b[100mAB\x1b[m');
  });

  it('keeps the foreground and the background independent', () => {
    expect(renderMarkup('{236-bg}{cyan-fg}AB{/cyan-fg}{/236-bg}')).toBe('\x1b[36;48;5;236mAB\x1b[m');
  });

  it('records the background on the span, not the foreground', () => {
    expect(tagsToSpans('{236-bg}AB{/236-bg}')).toEqual([
      { text: 'AB', bg: { kind: 'indexed', index: 236 } },
    ]);
    expect(tagsToSpans('{236-fg}AB{/236-fg}')).toEqual([
      { text: 'AB', fg: { kind: 'indexed', index: 236 } },
    ]);
  });

  it('does not read a background as a foreground', () => {
    // A parser that accepted `{236-bg}` in the foreground slot would paint
    // the TEXT instead of the cell behind it — the opposite of the intent.
    expect(tagsToSpans('{236-bg}AB{/236-bg}')[0]?.fg).toBeUndefined();
  });
});

describe('the live composer background', () => {
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

  async function settleRendered(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
  }

  it('leaves the terminal background visible in inline mode', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      inline: true,
      onSubmit: () => undefined,
    });
    app.start();
    await settleRendered();
    const rows = (app as unknown as { inlineInputLines: string[] }).inlineInputLines;
    app.stop();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toContain('-bg}');
  });

  it('leaves the terminal background visible in fullscreen mode', async () => {
    const out = sink();
    const app = new TUIApp({
      output: out.stream,
      input: new PassThrough(),
      onSubmit: () => undefined,
    });
    app.start();
    await settleRendered();
    const fullScreen = (app as unknown as { fullScreen: { content(region: 'input'): readonly string[] } }).fullScreen;
    const rows = fullScreen.content('input').map(String);
    app.stop();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join('')).not.toContain('-bg}');
    expect(out.text()).not.toContain('48;5;236m');
  });
});

describe('the submitted prompt', () => {
  function render(width?: number): string {
    const model = new TranscriptModel();
    model.addUser('hi');
    return renderTranscript(model, { ...OPTIONS, ...(width === undefined ? {} : { width }) });
  }

  it('sits on a band', () => {
    expect(render()).toContain('{238-bg}');
  });

  it('marks the prompt with a muted chevron and keeps the text in the user colour', () => {
    const row = render().split('\n')[0] ?? '';
    expect(row).toContain('{gray-fg}› {/gray-fg}');
    expect(row).toContain('{bright-green-fg}hi{/bright-green-fg}');
  });

  it('spans the pane when the width is known', () => {
    const row = render(20).split('\n')[0] ?? '';
    // The band is the pane wide: the row is padded inside the fill, which is
    // what makes a sent prompt read as a block rather than as a line.
    expect(visibleWidth(strip(row))).toBe(20);
  });

  it('leaves the text alone when the pane width is unknown', () => {
    const row = render().split('\n')[0] ?? '';
    // The marker and the text, and nothing else: without a pane there is no
    // band to span.
    expect(visibleWidth(strip(row))).toBe(4);
  });

  it('wraps a long prompt into rows that each carry the band', () => {
    const model = new TranscriptModel();
    model.addUser('one two three four five six seven eight nine ten');
    const rendered = renderTranscript(model, { ...OPTIONS, width: 20 });
    const rows = rendered.split('\n').filter((row) => row.includes('one') || row.includes('ten'));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith('{238-bg}')).toBe(true);
      expect(visibleWidth(strip(row))).toBe(20);
    }
  });
});

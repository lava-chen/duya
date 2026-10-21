import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { TranscriptRenderer } from '../transcript-cache.js';
import { WORKING_TAIL_INTERVAL_MS } from '../working-tail.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

function makeSink(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleRendered(): Promise<void> {
  await sleep(0);
  await sleep(MIN_RENDER_INTERVAL_MS + 40);
}

describe('TUIApp assembled transcript cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reuses long unchanged history across keystrokes and spinner frames, then refreshes on transcript changes', async () => {
    const lines = vi.spyOn(TranscriptRenderer.prototype, 'lines');
    const input = new PassThrough();
    const app = new TUIApp({
      input,
      output: makeSink(),
      inline: true,
      keyOverrides: {},
      onSubmit: () => {},
    });

    try {
      for (let index = 0; index < 1_200; index += 1) {
        app.printNotice(`history row ${index}`);
      }

      app.start();
      await sleep(0);
      expect(lines).toHaveBeenCalledTimes(1);

      for (const character of 'typing') input.write(character);
      await sleep(0);
      expect(lines).toHaveBeenCalledTimes(1);

      app.setBusy(true);
      await sleep(WORKING_TAIL_INTERVAL_MS * 2 + MIN_RENDER_INTERVAL_MS + 40);
      expect(lines).toHaveBeenCalledTimes(1);

      app.setBusy(false);
      await settleRendered();
      expect(lines).toHaveBeenCalledTimes(1);

      app.printNotice('new transcript content');
      await settleRendered();
      expect(lines).toHaveBeenCalledTimes(2);
      expect(lines.mock.results[1]?.value.join('\n')).toContain('new transcript content');

      input.write('x');
      await sleep(0);
      expect(lines).toHaveBeenCalledTimes(2);

      app.clearTranscript();
      expect(lines).toHaveBeenCalledTimes(3);
      expect(lines.mock.results[2]?.value.some((line) => line.includes('history row'))).toBe(false);
    } finally {
      app.stop();
    }
  });
});

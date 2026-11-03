import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { TUIApp } from '../TUIApp.js';

function app(): TUIApp {
  return new TUIApp({ output: new Writable({ write: (_chunk, _encoding, done) => done() }), input: new PassThrough(), onSubmit: () => {} });
}

describe('TUI transcript search and backtrack', () => {
  it('returns matching transcript blocks with stable human-readable row numbers', () => {
    const tui = app();
    tui.printUser('Find the rate limiter');
    tui.printNotice('Searching for the rate limiter implementation.');
    expect(tui.searchTranscript('RATE LIMITER')).toEqual([
      '1. user: Find the rate limiter',
      '2. notice: Searching for the rate limiter implementation.',
    ]);
    expect(tui.searchTranscript('not present')).toEqual([]);
    tui.stop();
  });

  it('copies the latest submitted prompt into the composer without altering the transcript', () => {
    const tui = app();
    tui.printUser('first request');
    tui.printUser('second request');
    expect(tui.editPreviousPrompt()).toBe(true);
    expect(tui.inputText).toBe('second request');
    expect(tui.searchTranscript('second request')).toHaveLength(1);
    expect(tui.editPreviousPrompt()).toBe(true);
    expect(tui.inputText).toBe('second request');
    tui.stop();
  });
});

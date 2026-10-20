/**
 * `/model` against the real TUI, not just its handler.
 *
 * The handler tests in `slash/__tests__/slash-commands.test.ts` prove the
 * command picks correctly from a Host catalog. This proves the thing the user
 * actually sees: running the command paints a docked selector in the composer's
 * slot, with each row carrying its window and flags, and Enter adopts the row.
 *
 * That split matters because "the model selector isn't there" was a real
 * report. A handler-level test would have passed throughout — it calls
 * `ctx.tui.choose` directly and never exercises `paintInput`, which is where
 * the panel is composed.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import { TUIApp } from '../TUIApp.js';
import { press } from './key-injection.js';
import { resolveTuiSlashCommand } from '../slash/index.js';

const ALT_BUFFER_ON = '\x1b[?1049h';
const plain = (value: string): string => value.replace(/\{[^}]*\}/gu, '');

function makeApp(): { app: TUIApp; out: () => string; input: PassThrough } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 100;
  (stream as unknown as { rows: number }).rows = 30;
  const input = new PassThrough();
  const app = new TUIApp({
    output: stream,
    input,
    inline: true,
    modelLabel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    onSubmit: () => {},
  });
  return { app, out: () => Buffer.concat(chunks).toString('utf8'), input };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60));
};

const CATALOG = [
  { providerId: 'deepseek', modelId: 'deepseek-flash', contextWindow: 1_000_000, supportsReasoning: true, source: 'preset', updatedAt: 0 },
  { providerId: 'deepseek', modelId: 'deepseek-pro', contextWindow: 200_000, source: 'preset', updatedAt: 0 },
];

function session(): Record<string, unknown> {
  return { id: 's1', providerId: 'deepseek', model: 'deepseek-flash' };
}

describe('/model in the TUI', () => {
  it('paints the selector in the dock with window, flags and current', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();

    const command = resolveTuiSlashCommand('model');
    if (command === undefined) throw new Error('/model is not registered');
    const client = {
      listProviderModelCapabilities: async () => CATALOG,
      update: async () => ({ updated: true, session: session() }),
    };
    const running = command.run(
      { client: client as never, session: session() as never, tui: app, busy: false },
      '',
    );
    await settle();

    const panel = (app as unknown as { inlineInputLines: string[] }).inlineInputLines.map(plain).join('\n');
    expect(panel).toContain('Select model · deepseek');
    // The current model is first and says so, with pi's units in its qualifier.
    expect(panel).toContain('❯ deepseek-flash  1.0M ctx · reasoning · current');
    expect(panel).toContain('deepseek-pro  200k ctx');
    expect(panel).toContain('type to filter');
    // A secondary page is docked, never an alternate-buffer takeover.
    expect(out()).not.toContain(ALT_BUFFER_ON);

    press(input, 'escape');
    await running;
    app.stop();
  });

  it('adopts the row the user chooses', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();

    const command = resolveTuiSlashCommand('model');
    if (command === undefined) throw new Error('/model is not registered');
    const updates: Array<{ model?: string }> = [];
    const client = {
      listProviderModelCapabilities: async () => CATALOG,
      update: async (_sessionId: string, _expectedUpdatedAt: unknown, patch: { model?: string }) => {
        updates.push(patch);
        return { updated: true, session: { ...session(), model: patch.model } };
      },
    };
    const running = command.run(
      { client: client as never, session: session() as never, tui: app, busy: false },
      '',
    );
    await settle();

    // Second row is deepseek-pro: one step down, then Enter.
    press(input, 'down');
    await settle();
    press(input, 'return');
    const outcome = await running;
    app.stop();

    expect(updates).toEqual([{ model: 'deepseek-pro' }]);
    expect(outcome.kind).toBe('session_updated');
  });
});

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

const CATALOG = {
  providers: [
    {
      providerId: 'deepseek',
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      hasApiKey: true,
      models: [
        {
          modelId: 'deepseek-flash',
          contextWindow: 1_000_000,
          supportsReasoning: true,
          reasoningEffortOptions: ['low', 'medium', 'high'],
        },
        { modelId: 'deepseek-pro', contextWindow: 200_000 },
      ],
    },
    {
      providerId: 'minimax-cn',
      name: 'MiniMax CN',
      providerType: 'anthropic',
      hasApiKey: true,
      models: [{ modelId: 'MiniMax-M3', contextWindow: 1_000_000 }],
    },
  ],
  configRoot: '/tmp/duya-config',
};

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
      getProviderCatalog: async () => CATALOG,
      update: async () => ({ updated: true, session: session() }),
    };
    const running = command.run(
      { client: client as never, session: session() as never, tui: app, busy: false },
      '',
    );
    await settle();

    const panel = (app as unknown as { inlineInputLines: string[] }).inlineInputLines.map(plain).join('\n');
    expect(panel).toContain('Select model · 2 providers');
    // The current model is first and says so, with pi's units in its qualifier.
    expect(panel).toContain('❯ deepseek-flash');
    expect(panel).toContain('DeepSeek · 1.0M ctx · reasoning · low/medium/high · current');
    expect(panel).toContain('deepseek-pro');
    expect(panel).toContain('200k ctx');
    // Another provider's model is in the same list, with its provider named.
    expect(panel).toContain('MiniMax-M3');
    expect(panel).toContain('MiniMax CN');
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
    const updates: Array<{ model?: string; providerId?: string }> = [];
    const client = {
      getProviderCatalog: async () => CATALOG,
      update: async (
        _sessionId: string,
        _expectedUpdatedAt: unknown,
        patch: { model?: string; providerId?: string },
      ) => {
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

  it('switches the provider with the model when the row belongs to another provider', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();

    const command = resolveTuiSlashCommand('model');
    if (command === undefined) throw new Error('/model is not registered');
    const updates: Array<{ model?: string; providerId?: string }> = [];
    const client = {
      getProviderCatalog: async () => CATALOG,
      update: async (
        _sessionId: string,
        _expectedUpdatedAt: unknown,
        patch: { model?: string; providerId?: string },
      ) => {
        updates.push(patch);
        return { updated: true, session: { ...session(), ...patch } };
      },
    };
    const running = command.run(
      { client: client as never, session: session() as never, tui: app, busy: false },
      '',
    );
    await settle();

    // Third row is the other provider's model.
    press(input, 'down');
    press(input, 'down');
    await settle();
    press(input, 'return');
    await running;
    app.stop();

    expect(updates).toEqual([{ model: 'MiniMax-M3', providerId: 'minimax-cn' }]);
  });
});

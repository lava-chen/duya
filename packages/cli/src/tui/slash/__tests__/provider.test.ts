/**
 * `/provider` — the add wizard, the edit flow, and the two failure paths that
 * decide whether a bad connection survives the write.
 *
 * The command's whole job is to make one Host call per decision and then hand a
 * complete row to `upsertProvider`, so most of these cases assert the SHAPE of
 * what crossed that boundary: that an edit echoes the fields it did not touch
 * (the Host replaces declared fields rather than merging them), that every write
 * carries the revision it read, and that a probe which fails after the save puts
 * back what was there.
 */

import { describe, expect, it } from 'vitest';
import type { HostProviderDetail, HostProviderList, HostSessionRecord } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { TuiChoice } from '../../TUIApp.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';
import { PROVIDER_COMMANDS } from '../provider.js';

const COMMAND = PROVIDER_COMMANDS[0];
if (COMMAND === undefined) throw new Error('provider.ts exports no command');

function provider(overrides: Partial<HostProviderDetail> = {}): HostProviderDetail {
  return {
    providerId: 'deepseek',
    name: 'DeepSeek',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    hasApiKey: true,
    maskedApiKey: 'sk-d***1234',
    isDefault: true,
    ...overrides,
  };
}

interface Probe {
  readonly ok: boolean;
  readonly modelIds?: readonly string[];
  readonly message?: string;
}

function makeContext(options: {
  readonly providers?: readonly HostProviderDetail[];
  readonly listError?: string;
  readonly busy?: boolean;
  /** Answers for successive `promptText` calls; `null` cancels. */
  readonly answers?: readonly (string | null)[];
  /** Answers for successive `choose` calls; `null` cancels. */
  readonly pick?: readonly (string | null)[];
  readonly probe?: Probe;
  readonly restoreProbe?: Probe;
} = {}) {
  const notices: string[] = [];
  const errors: string[] = [];
  const choices: TuiChoice[][] = [];
  const prompts: Array<{ title: string; options?: { initialValue?: string; secret?: boolean } }> = [];
  const upserted: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const answerQueue = [...(options.answers ?? [])];
  const pickQueue = [...(options.pick ?? [])];
  let probes = 0;

  const tui = {
    printNotice: (text: string) => notices.push(text),
    printError: (text: string) => errors.push(text),
    choose: async (_title: string, items: readonly TuiChoice[]) => {
      choices.push([...items]);
      return pickQueue.length > 0 ? (pickQueue.shift() as string | null) : null;
    },
    promptText: async (title: string, opts?: { initialValue?: string; secret?: boolean }) => {
      prompts.push({ title, options: opts });
      return answerQueue.length > 0 ? (answerQueue.shift() as string | null) : null;
    },
  } as unknown as TuiSlashHost;

  const client = {
    listProviders: async (): Promise<HostProviderList> => {
      if (options.listError !== undefined) {
        return { providers: [], configRoot: 'C:/cfg', revision: 'rev-1', error: options.listError };
      }
      return { providers: options.providers ?? [], configRoot: 'C:/cfg', revision: 'rev-1' };
    },
    upsertProvider: async (input: Record<string, unknown>) => {
      upserted.push(input);
      const providerId = (input.providerId as string | undefined) ?? 'created-id';
      return {
        provider: provider({ providerId, name: input.name as string }),
        revision: `rev-${upserted.length + 1}`,
      };
    },
    deleteProvider: async (providerId: string) => {
      deleted.push(providerId);
      return { revision: 'rev-deleted' };
    },
    testProvider: async () => {
      probes += 1;
      // The first probe answers with `probe`, later ones with `restoreProbe`, so
      // a test can describe "the retry after a restore failed too".
      const answer = probes === 1 ? options.probe : (options.restoreProbe ?? options.probe);
      return {
        ok: answer?.ok ?? true,
        code: answer?.ok === false ? 'unauthorized' : 'ok',
        latencyMs: 12,
        modelIds: answer?.modelIds ?? ['deepseek-chat'],
        ...(answer?.message === undefined ? {} : { message: answer.message }),
      };
    },
  } as unknown as HostSessionHttpClient;

  const ctx = {
    client,
    session: {} as HostSessionRecord,
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  return { ctx, notices, errors, choices, prompts, upserted, deleted };
}

describe('/provider — guards', () => {
  it('refuses to write while a turn streams, before reading anything', async () => {
    const { ctx, errors, upserted } = makeContext({ busy: true, providers: [provider()] });
    await COMMAND.run(ctx, 'add');
    expect(errors[0]).toContain('turn');
    expect(upserted).toHaveLength(0);
  });

  it('names the configuration file when the Host cannot read it', async () => {
    const { ctx, errors } = makeContext({ listError: 'config.toml is malformed' });
    await COMMAND.run(ctx, '');
    expect(errors[0]).toContain('config.toml is malformed');
    expect(errors[0]).toContain('C:/cfg');
  });

  it('reports an unknown provider id instead of guessing', async () => {
    const { ctx, errors, choices } = makeContext({ providers: [provider()] });
    await COMMAND.run(ctx, 'nope');
    expect(errors[0]).toContain('nope');
    expect(choices).toHaveLength(0);
  });
});

describe('/provider add', () => {
  it('writes a full row and reports the probe', async () => {
    const { ctx, notices, upserted } = makeContext({
      pick: ['openai-compatible'],
      answers: [
        'deepseek',
        'DeepSeek',
        'https://api.deepseek.com/v1',
        'deepseek-chat, deepseek-reasoner',
        'sk-new',
      ],
    });
    await COMMAND.run(ctx, 'add');

    expect(upserted[0]).toMatchObject({
      providerId: 'deepseek',
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      apiKey: 'sk-new',
    });
    expect(notices[0]).toContain('Added');
  });

  it('never puts the key in a notice', async () => {
    const { ctx, notices, errors } = makeContext({
      pick: ['anthropic'],
      answers: ['a', 'A', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', 'sk-ant-secret'],
    });
    await COMMAND.run(ctx, 'add');
    for (const line of [...notices, ...errors]) expect(line).not.toContain('sk-ant-secret');
  });

  it('refuses an id that is not a usable TOML table key', async () => {
    const { ctx, errors, upserted } = makeContext({
      answers: ['9 bad id'],
      pick: ['openai-compatible'],
    });
    await COMMAND.run(ctx, 'add');
    expect(errors[0]).toContain('starts with a letter');
    expect(upserted).toHaveLength(0);
  });

  it('refuses to shadow an existing provider', async () => {
    const { ctx, errors, upserted } = makeContext({
      providers: [provider()],
      answers: ['deepseek'],
      pick: ['openai-compatible'],
    });
    await COMMAND.run(ctx, 'add');
    expect(errors[0]).toContain('already exists');
    expect(upserted).toHaveLength(0);
  });

  it('refuses a base URL that is not http(s) before writing', async () => {
    const { ctx, errors, upserted } = makeContext({
      pick: ['openai-compatible'],
      answers: ['p', 'P', 'ftp://example.test', 'm', 'sk-1'],
    });
    await COMMAND.run(ctx, 'add');
    expect(errors[0]).toContain('http');
    expect(upserted).toHaveLength(0);
  });

  it('requires at least one model', async () => {
    const { ctx, errors, upserted } = makeContext({
      pick: ['openai-compatible'],
      answers: ['p', 'P', 'https://example.test/v1', ' , , ', 'sk-1'],
    });
    await COMMAND.run(ctx, 'add');
    expect(errors[0]).toContain('model');
    expect(upserted).toHaveLength(0);
  });

  it('removes the row it just created when the probe fails', async () => {
    const { ctx, errors, deleted, upserted } = makeContext({
      pick: ['openai-compatible'],
      answers: ['fresh', 'Fresh', 'https://x.test/v1', 'm1', 'sk-1'],
      probe: { ok: false, message: '401 unauthorized' },
    });
    await COMMAND.run(ctx, 'add');

    expect(upserted).toHaveLength(1);
    expect(deleted).toEqual(['fresh']);
    expect(errors[0]).toContain('401 unauthorized');
  });

  it('cancelling the wizard writes nothing', async () => {
    const { ctx, upserted } = makeContext({
      pick: ['openai-compatible'],
      answers: ['deepseek', null],
    });
    await COMMAND.run(ctx, 'add');
    expect(upserted).toHaveLength(0);
  });
});

describe('/provider <id> — the edit form', () => {
  it('echoes every untouched field so the Host does not blank them', async () => {
    const detail = provider({ alias: 'work-key', defaultModel: 'deepseek-chat' });
    const { ctx, upserted } = makeContext({
      providers: [detail],
      pick: ['models'],
      answers: ['deepseek-chat, deepseek-reasoner'],
      probe: { ok: true, modelIds: ['deepseek-chat', 'deepseek-reasoner'] },
    });
    await COMMAND.run(ctx, 'deepseek');

    expect(upserted[0]).toMatchObject({
      providerId: 'deepseek',
      name: 'DeepSeek',
      alias: 'work-key',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      expectedRevision: 'rev-1',
    });
    // No key was typed, so none is sent: absent means "keep the stored one".
    expect(upserted[0]).not.toHaveProperty('apiKey');
  });

  it('offers the probed ids and the configured ones as the starting list', async () => {
    const { ctx, prompts } = makeContext({
      providers: [provider({ models: ['configured-model'] })],
      pick: ['models'],
      answers: [null],
      probe: { ok: true, modelIds: ['remote-a', 'remote-b'] },
    });
    await COMMAND.run(ctx, 'deepseek');

    const modelsPrompt = prompts.find((prompt) => prompt.title.includes('Models'));
    expect(modelsPrompt?.options?.initialValue).toContain('configured-model');
    expect(modelsPrompt?.options?.initialValue).toContain('remote-a');
    expect(modelsPrompt?.options?.initialValue).toContain('remote-b');
  });

  it('drops a default model the new list no longer offers', async () => {
    const { ctx, upserted } = makeContext({
      providers: [provider({ models: ['gone'], defaultModel: 'gone' })],
      pick: ['models'],
      answers: ['kept'],
      probe: { ok: true, modelIds: ['kept'] },
    });
    await COMMAND.run(ctx, 'deepseek');

    expect(upserted[0]).toMatchObject({ models: ['kept'], defaultModel: 'kept' });
  });

  it('still offers the list when the probe fails, and says so', async () => {
    const { ctx, errors, prompts, upserted } = makeContext({
      providers: [provider()],
      pick: ['models'],
      answers: ['deepseek-chat'],
      // The candidate probe fails, but the save-time check succeeds: the point
      // of the case is that a failed probe degrades the FORM, it does not stop
      // the user from saving a list they typed themselves.
      probe: { ok: false, message: 'timeout' },
      restoreProbe: { ok: true, modelIds: ['deepseek-chat'] },
    });
    await COMMAND.run(ctx, 'deepseek');

    expect(prompts.some((prompt) => prompt.title.includes('Models'))).toBe(true);
    expect(errors[0]).toContain('timeout');
    expect(upserted).toHaveLength(1);
  });

  it('restores the previous row when the probe fails after the save', async () => {
    const detail = provider();
    const { ctx, errors, upserted } = makeContext({
      providers: [detail],
      pick: ['baseUrl'],
      answers: ['https://broken.test/v1'],
      probe: { ok: false, message: 'dns failure' },
    });
    await COMMAND.run(ctx, 'deepseek');

    expect(upserted).toHaveLength(2);
    expect(upserted[0]).toMatchObject({ baseUrl: 'https://broken.test/v1' });
    // The restore rewrites the row as it was read, against the revision the
    // failed write produced — not the stale one the form started from.
    expect(upserted[1]).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      expectedRevision: 'rev-2',
    });
    expect(errors[0]).toContain('dns failure');
    expect(errors[0]).toContain('Restored');
  });

  it('replaces the key when one is typed, and keeps the mask out of the write', async () => {
    const detail = provider({ maskedApiKey: 'sk-d***1234' });
    const { ctx, upserted } = makeContext({
      providers: [detail],
      pick: ['apiKey'],
      answers: ['sk-brand-new'],
    });
    await COMMAND.run(ctx, 'deepseek');

    expect(upserted[0]).toMatchObject({ apiKey: 'sk-brand-new' });
    expect(JSON.stringify(upserted[0])).not.toContain('***');
  });

  it('refuses an empty key rather than clearing the stored one', async () => {
    const { ctx, errors, upserted } = makeContext({
      providers: [provider()],
      pick: ['apiKey'],
      answers: ['   '],
    });
    await COMMAND.run(ctx, 'deepseek');
    expect(errors[0]).toContain('unchanged');
    expect(upserted).toHaveLength(0);
  });

  it('probes without writing when the user only asked for a test', async () => {
    const { ctx, notices, upserted } = makeContext({ providers: [provider()], pick: ['test'] });
    await COMMAND.run(ctx, 'deepseek');
    expect(upserted).toHaveLength(0);
    expect(notices[0]).toContain('DeepSeek');
  });

  it('offers "test connection" as a row, so a probe needs no staged edit', async () => {
    const { ctx, choices } = makeContext({ providers: [provider()], pick: [null] });
    await COMMAND.run(ctx, 'deepseek');
    const menu = choices[0] ?? [];
    expect(menu.map((choice) => choice.value)).toContain('test');
  });
});

describe('/provider — the picker', () => {
  it('lists the configured providers and an add row', async () => {
    const { ctx, choices } = makeContext({
      providers: [provider(), provider({ providerId: 'other', name: 'Other', isDefault: false })],
      pick: [null],
    });
    await COMMAND.run(ctx, '');
    const values = (choices[0] ?? []).map((choice) => choice.value);
    expect(values).toContain('deepseek');
    expect(values).toContain('other');
    expect((choices[0] ?? []).at(-1)?.label).toContain('Add');
  });

  it('goes straight to the wizard when nothing is configured yet', async () => {
    const { ctx, notices, prompts } = makeContext({
      providers: [],
      pick: ['openai-compatible'],
      answers: [null],
    });
    await COMMAND.run(ctx, '');
    expect(notices[0]).toContain('No providers');
    expect(prompts[0]?.title).toContain('Provider id');
  });
});

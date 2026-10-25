/**
 * packages/cli/src/tui/slash/__tests__/slash-commands.test.ts
 *
 * Covers the pure helpers and the command handlers against a fake Host
 * client — no TTY, no network.
 *
 * The fixtures are deliberately discriminating: every pair used in an
 * assertion differs in a way that makes a wrong implementation produce a
 * DIFFERENT number, not just different formatting. A cache-exclusive usage
 * block and a cache-inclusive one differ in `newInput` (100 vs 1000); an
 * anchor with and without `last_call` differ by 7500 tokens. A fixture that
 * only differed by whitespace would pass against a broken implementation.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { HostSessionRecord } from '@duya/agent-protocol';
import { allProviderModels } from '@duya/ai';
import type { HostSessionHttpClient } from '@duya/host/http-client';

import {
  EMPTY_TOTALS,
  formatTokens,
  formatUsd,
  historyQuery,
  loadSessionMessages,
  sumMessageUsage,
} from '../shared.js';
import {
  TUI_SLASH_COMMANDS,
  buildSlashCompletionRows,
  buildSlashHelpSections,
  hasTuiSlashCommand,
  resolveTuiSlashCommand,
} from '../index.js';
import type { TuiSlashActions, TuiSlashContext, TuiSlashHost } from '../index.js';
import { specsForSurface } from '@duya/command-catalog';
import { ACTION_DEFS } from '../../actions.js';
import { applyKeyOverrides } from '../../keymap.js';

// ───────────────────────────── fixtures ─────────────────────────────

function message(
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { role, content, id: `m-${Math.random().toString(16).slice(2)}`, ...extra };
}

/** Wrap transcript messages as the durable entries readMessages returns. */
function page(messages: ReadonlyArray<Record<string, unknown>>) {
  return {
    sessionId: 's1',
    messages: messages.map((message, index) => ({
      id: String(message.id ?? index),
      sequence: index,
      createdAt: 1_700_000_000_000 + index,
      turnId: null,
      entry: {
        type: 'message',
        id: String(message.id ?? index),
        parentId: null,
        createdAt: 1_700_000_000_000 + index,
        message,
      },
    })),
    nextCursor: null,
  };
}

const SESSION = {
  id: 's1',
  title: 'Demo session',
  model: 'gpt-x',
  providerId: 'p1',
  mode: 'code',
  permissionMode: 'auto',
  status: 'idle',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  workspace: { state: 'bound', workspaceId: 'w1', rootId: 'r1', relativePath: '.' },
} as unknown as HostSessionRecord;

function makeHost(): { host: TuiSlashHost; notices: string[]; errors: string[] } {
  const notices: string[] = [];
  const errors: string[] = [];
  const host: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
  };
  return { host, notices, errors };
}

function makeContext(
  overrides: Partial<HostSessionHttpClient>,
  hostOverrides: Partial<TuiSlashHost> = {},
  session: HostSessionRecord = SESSION,
  actions?: TuiSlashActions,
): TuiSlashContext & { notices: string[]; errors: string[] } {
  const { host, notices, errors } = makeHost();
  return {
    client: overrides as unknown as HostSessionHttpClient,
    session,
    tui: { ...host, ...hostOverrides },
    busy: false,
    ...(actions === undefined ? {} : { actions }),
    notices,
    errors,
  };
}

function makeActions() {
  const interrupt = vi.fn();
  const adoptSession = vi.fn(async () => {});
  const startFreshSession = vi.fn(async () => {});
  const reloadTranscript = vi.fn(async () => {});
  return {
    interrupt,
    adoptSession,
    startFreshSession,
    reloadTranscript,
    actions: { interrupt, adoptSession, startFreshSession, reloadTranscript } satisfies TuiSlashActions,
  };
}

function command(name: string) {
  const resolved = resolveTuiSlashCommand(name);
  if (resolved === undefined) throw new Error(`no such command: /${name}`);
  return resolved;
}

// ───────────────────────────── shared.ts ─────────────────────────────

describe('slash/shared token accounting', () => {
  it('counts cache hits once for a cache-exclusive provider', () => {
    // input excludes the cache: 100 new tokens, 900 already-counted hits.
    const totals = sumMessageUsage([
      message('assistant', 'a', {
        tokenUsage: { input_tokens: 100, output_tokens: 20, cache_hit_tokens: 900 },
      }),
    ]);
    expect(totals.newInput).toBe(100);
    expect(totals.rawInput).toBe(100);
    expect(totals.cacheRead).toBe(900);
    expect(totals.output).toBe(20);
  });

  it('does not subtract anything for a cache-inclusive provider', () => {
    // Same fixture, different convention: input already contains the cache.
    const totals = sumMessageUsage([
      message('assistant', 'a', {
        tokenUsage: { input_tokens: 1000, output_tokens: 20, cache_hit_tokens: 100 },
      }),
    ]);
    expect(totals.newInput).toBe(1000);
    expect(totals.rawInput).toBe(1000);
  });

  it('adds cache writes but never cache reads to the new-input total', () => {
    const totals = sumMessageUsage([
      message('assistant', 'a', {
        tokenUsage: { input_tokens: 50, output_tokens: 0, cache_hit_tokens: 4000, cache_creation_tokens: 30 },
      }),
    ]);
    // 80 = 50 + 30 written; the 4000 hits are a re-read and must not accumulate.
    expect(totals.newInput).toBe(80);
    expect(totals.cacheWrite).toBe(30);
  });

  it('ignores non-assistant messages that carry no usage block', () => {
    const totals = sumMessageUsage([
      message('user', 'hi', { tokenUsage: { input_tokens: 999, output_tokens: 1 } }),
      message('assistant', 'ok'),
    ]);
    expect(totals).toEqual(EMPTY_TOTALS);
    expect(totals.hasUsage).toBe(false);
  });
});

describe('slash/shared history projection', () => {
  it('folds rebased rows out for the LLM-visible view', () => {
    // Accounting must describe what the model was actually sent, otherwise a
    // rebase double-counts the superseded prompt.
    expect(historyQuery('llm-visible')).toEqual({ includeSuperseded: false });
  });

  it('keeps superseded rows for the human-readable view', () => {
    expect(historyQuery('full')).toEqual({ includeSuperseded: true });
  });
});

describe('slash/shared formatting', () => {
  it('formats token counts at the pi boundaries', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(45_600)).toBe('46k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  it('keeps sub-cent costs visible instead of rounding them away', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(3)).toBe('$3.00');
  });
});

// ───────────────────────────── registry ─────────────────────────────

describe('slash registry', () => {
  it('resolves names, aliases and casing', () => {
    expect(resolveTuiSlashCommand('usage')?.name).toBe('cost');
    expect(resolveTuiSlashCommand('cost')?.name).toBe('cost');
    expect(resolveTuiSlashCommand('  Model ')?.name).toBe('model');
    expect(hasTuiSlashCommand('CONTEXT')).toBe(true);
    expect(resolveTuiSlashCommand('nope')).toBeUndefined();
  });

  it('registers every command under its canonical name exactly once', () => {
    const names = TUI_SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // A fixed list on purpose: an assertion built by filtering the expected
    // values against the actual names would pass no matter what was added.
    expect([...names].sort()).toEqual([
      'archive',
      'btw',
      'capabilities',
      'checkout',
      'compact',
      'context',
      'copy',
      'cost',
      'delete',
      'diff',
      'effort',
      'export',
      'fork',
      'hotkeys',
      'mcp',
      'model',
      'permission',
      'pr',
      'read-file',
      'rename',
      'settings',
      'skills',
      'status',
      'stop',
      'tasks',
      'thinking',
      'transcript',
    ]);
  });

  it('uses the shared catalog as the naming authority for every handler', () => {
    // The popup renders the catalog; if a handler disagreed on the canonical
    // name or the alias set, the two surfaces would advertise different
    // spellings for one command.
    const advertised = new Map(
      specsForSurface('cli').map((spec) => [spec.name, spec.aliases ?? []]),
    );
    for (const command of TUI_SLASH_COMMANDS) {
      const aliases = advertised.get(command.name);
      expect(aliases, `${command.name} is not in the CLI catalog view`).toBeDefined();
      expect([...(command.aliases ?? [])].sort(), `${command.name} aliases`).toEqual([...aliases].sort());
    }
  });

  it('keeps aliases unique and free of collisions with canonical names', () => {
    const canonical = new Set(TUI_SLASH_COMMANDS.map((c) => c.name));
    const seen = new Map<string, string>();
    for (const command of TUI_SLASH_COMMANDS) {
      for (const alias of command.aliases ?? []) {
        expect(canonical.has(alias)).toBe(false);
        const owner = seen.get(alias);
        expect(owner === undefined || owner === command.name).toBe(true);
        seen.set(alias, command.name);
      }
    }
  });

  it('has a handler for every command the catalog advertises to the CLI', () => {
    // The reverse of the test above. The catalog said a command was a CLI
    // command; the CLI must be able to run it. A catalog entry with no
    // handler would be advertised and then answer "unknown command" — the
    // failure mode the catalog's own integrity tests forbid.
    //
    // Six commands are implemented by the chat loop itself rather than by a
    // `slash/` handler: they need the loop's queue, transcript and session
    // transition, which a handler cannot reach. They are listed here so the
    // exception is visible instead of implied.
    const IMPLEMENTED_BY_THE_CHAT_LOOP = ['new', 'resume', 'clear', 'queue', 'exit', 'help'];
    const advertised = specsForSurface('cli').map((spec) => spec.name);
    const missing = advertised.filter(
      (name) => !hasTuiSlashCommand(name) && !IMPLEMENTED_BY_THE_CHAT_LOOP.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the chat-loop exceptions and the catalog in step', () => {
    // The exception list above is a literal; if the catalog drops one of
    // these commands, or a handler for one appears, this fails so the
    // exception does not quietly become a lie.
    for (const name of ['new', 'resume', 'clear', 'queue', 'exit', 'help']) {
      expect(specsForSurface('cli').some((spec) => spec.name === name), name).toBe(true);
      expect(hasTuiSlashCommand(name), name).toBe(false);
    }
  });

  it('offers the same commands in the completion popup and in /help', () => {
    const popup = buildSlashCompletionRows().map((row) => row.value);
    expect(popup).toContain('/model');
    expect(popup).toContain('/export');
    const help = buildSlashHelpSections().flatMap((section) => section.lines).join('\n');
    for (const value of popup) {
      expect(help).toContain(value);
    }
  });
});

// ───────────────────────────── handlers ─────────────────────────────

describe('/effort', () => {
  const capability = (options: readonly string[] | undefined) => ({
    getProviderModelCapability: vi.fn(async () => ({
      providerId: 'p1',
      modelId: 'gpt-x',
      supportsReasoning: true,
      ...(options === undefined ? {} : { reasoningEffortOptions: options }),
      source: 'user',
      updatedAt: 1,
    })),
  });
  const settings = (effort: string, extra: Readonly<Record<string, string>> = {}) => ({
    getSettings: vi.fn(async () => ({ 'cli.tui.effort': effort, ...extra })),
  });
  /** The per-model map, as `/settings` writes it (one key, JSON object). */
  const effortByModel = (map: Readonly<Record<string, string>>) => ({
    'cli.tui.effortByModel': JSON.stringify(map),
  });

  it('offers auto plus the levels the model declares', async () => {
    const choose = vi.fn(async () => 'high');
    const ctx = makeContext({ ...capability(['low', 'high']), ...settings('medium') }, { choose });
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string }[];
    expect(offered.map((choice) => choice.value)).toEqual(['auto', 'low', 'high']);
  });

  it('takes the tiers from the provider catalog when the catalog knows them', async () => {
    // The catalog carries the model's OWN ladder (MiniMax M3 answers to
    // low/medium/high/max), which the override table does not have on a
    // machine whose providers came from the configuration file.
    const choose = vi.fn(async () => null);
    const ctx = makeContext({
      getProviderCatalog: vi.fn(async () => ({
        providers: [
          {
            providerId: 'p1',
            name: 'Provider One',
            providerType: 'anthropic',
            hasApiKey: true,
            models: [
              { modelId: 'gpt-x', reasoningEffortOptions: ['low', 'medium', 'high', 'max'] },
            ],
          },
        ],
        configRoot: '/tmp/duya-config',
      })),
      ...settings('medium'),
    }, { choose });
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string }[];
    expect(offered.map((choice) => choice.value)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
  });

  it('keeps the ladder when the session sits on a preset instead of a configured model', async () => {
    // `/model` can put the session on a vendor preset the configuration never
    // named. Reading only `models` here would silently downgrade that session
    // to the default four levels.
    const choose = vi.fn(async () => null);
    const ctx = makeContext({
      getProviderCatalog: vi.fn(async () => ({
        providers: [
          {
            providerId: 'p1',
            name: 'Provider One',
            providerType: 'anthropic',
            hasApiKey: true,
            models: [{ modelId: 'gpt-x', reasoningEffortOptions: ['low', 'high'] }],
            presetModels: [
              { modelId: 'gpt-r', reasoningEffortOptions: ['low', 'medium', 'high', 'max'] },
            ],
          },
        ],
        configRoot: '/tmp/duya-config',
      })),
      ...settings('medium'),
    }, { choose }, { ...SESSION, model: 'gpt-r' } as HostSessionRecord);
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string }[];
    expect(offered.map((choice) => choice.value)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
  });

  it('marks the persisted level as the current row', async () => {
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...capability(['low', 'high']), ...settings('high') }, { choose });
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string; description?: string }[];
    expect(offered.find((choice) => choice.value === 'high')?.description).toContain('current');
    expect(offered.find((choice) => choice.value === 'low')?.description).toBeUndefined();
  });

  it('marks the EFFECTIVE level current, not the global one', async () => {
    // The border already shows `high` because this model overrides it. A picker
    // that ticked `low` would be pointing at a value nothing else believes.
    const choose = vi.fn(async () => null);
    const ctx = makeContext(
      { ...capability(['low', 'high']), ...settings('low', effortByModel({ 'gpt-x': 'high' })) },
      { choose },
    );
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string; description?: string }[];
    expect(offered.find((choice) => choice.value === 'high')?.description).toContain('current');
    expect(offered.find((choice) => choice.value === 'low')?.description).toBeUndefined();
  });

  it('tells the user why the border will not move when this model overrides', async () => {
    const ctx = makeContext(
      { ...capability(['low', 'medium', 'high']), ...settings('low', effortByModel({ 'gpt-x': 'high' })) },
      {},
    );
    const outcome = await command('effort').run(ctx, 'medium');
    expect(outcome).toEqual({ kind: 'effort_changed', effort: 'medium' });
    // This command sets the GLOBAL default. Without this sentence a change
    // that leaves this session's border untouched reads as a bug.
    expect(ctx.notices.join('\n')).toContain('gpt-x keeps its own default (High)');
  });

  it('says nothing about overrides when there is none', async () => {
    const ctx = makeContext({ ...capability(['low', 'medium']), ...settings('low') }, {});
    await command('effort').run(ctx, 'medium');
    expect(ctx.notices.join('\n')).not.toContain('keeps its own default');
  });

  it('falls back to the levels the Desktop offers when the model says nothing', async () => {
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...capability(undefined), ...settings('auto') }, { choose });
    await command('effort').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { value: string }[];
    expect(offered.map((choice) => choice.value)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
  });

  it('still opens the picker when the capability read fails', async () => {
    const choose = vi.fn(async () => 'low');
    const ctx = makeContext({
      getProviderModelCapability: vi.fn(async () => { throw new Error('host down'); }),
      ...settings('auto'),
    }, { choose });
    const outcome = await command('effort').run(ctx, '');
    expect(choose).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'effort_changed', effort: 'low' });
  });

  it('accepts a level argument without opening the picker', async () => {
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...capability(['low', 'high']), ...settings('auto') }, { choose });
    const outcome = await command('effort').run(ctx, 'High');
    expect(choose).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'effort_changed', effort: 'high' });
    expect(ctx.notices.join('\n')).toContain('Reasoning effort: High');
  });

  it('treats auto as "no override" so the model decides', async () => {
    const ctx = makeContext({ ...capability(['low']), ...settings('high') }, { choose: async () => 'auto' });
    const outcome = await command('effort').run(ctx, '');
    expect(outcome).toEqual({ kind: 'effort_changed', effort: null });
  });

  it('rejects an unknown level and lists what is available', async () => {
    const ctx = makeContext({ ...capability(['low', 'high']), ...settings('auto') });
    const outcome = await command('effort').run(ctx, 'turbo');
    expect(outcome).toEqual({ kind: 'handled' });
    expect(ctx.errors.join('\n')).toContain('Unknown effort "turbo"');
    expect(ctx.errors.join('\n')).toContain('auto, low, high');
  });
});

describe('/hotkeys', () => {
  const panelHost = () => {
    const panels: Array<{ title: string; lines: readonly string[] }> = [];
    return {
      panels,
      showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); },
    };
  };

  it('lists every binding, grouped, in one panel', async () => {
    const host = panelHost();
    const ctx = makeContext({}, host);
    await command('hotkeys').run(ctx, '');

    expect(host.panels).toHaveLength(1);
    expect(host.panels[0]?.title).toBe('Key bindings');
    const body = host.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('Global');
    expect(body).toContain('Editor');
    expect(body).toContain('Background tasks');
    expect(body).toContain('Ctrl+R');
    // The row only exists because the binding does: see the `exit` def in
    // `actions.ts`. An advertised key that is not listed here is a key the
    // user has to discover by pressing it.
    expect(body).toContain('Ctrl+D');
  });

  it('quotes the bindings in force, not the defaults they were overridden from', async () => {
    const host = panelHost();
    // What `~/.duya/config.toml` [tui.keys] produces. A list that printed the
    // default would be describing a TUI that is not on the screen.
    const effective = applyKeyOverrides(ACTION_DEFS, { history: 'Ctrl+J' });
    const ctx = makeContext({}, { ...host, effectiveKeyBindings: () => effective });
    await command('hotkeys').run(ctx, '');

    const body = host.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('Ctrl+J');
    expect(body).not.toContain('Ctrl+R\n');
  });

  it('still answers on a host with no panel', async () => {
    const ctx = makeContext({}, { showPanel: undefined });
    await command('hotkeys').run(ctx, '');
    expect(ctx.notices.join('\n')).toContain('Ctrl+R');
    expect(ctx.notices.join('\n')).toContain('Global');
  });
});

describe('/model', () => {
  /**
   * The catalog the Host reads from `~/.duya/config.toml`: every configured
   * provider with the models it serves.
   */
  const catalog = {
    providers: [
      {
        providerId: 'p1',
        name: 'Provider One',
        providerType: 'anthropic',
        hasApiKey: true,
        models: [
          {
            modelId: 'gpt-x',
            contextWindow: 200_000,
            supportsReasoning: true,
            reasoningEffortOptions: ['low', 'medium', 'high'],
          },
          { modelId: 'gpt-xl', contextWindow: 1_000_000 },
        ],
      },
      {
        providerId: 'p2',
        name: 'Provider Two',
        providerType: 'openrouter',
        hasApiKey: true,
        models: [{ modelId: 'gpt-x', contextWindow: 500_000 }],
      },
    ],
    configRoot: '/tmp/duya-config',
  };

  const capabilities = {
    getProviderCatalog: vi.fn(async () => catalog),
  };

  it('picks from the provider catalog and returns the new session', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, model: 'gpt-xl' } as HostSessionRecord,
    }));
    const ctx = makeContext(
      { ...capabilities, update },
      { choose: async () => 'p1::gpt-xl' },
    );
    const outcome = await command('model').run(ctx, '');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[2]).toEqual({ model: 'gpt-xl' });
    expect(outcome).toEqual({ kind: 'session_updated', session: { ...SESSION, model: 'gpt-xl' } });
    expect(ctx.notices.join('\n')).toContain('Model switched to gpt-xl');
  });

  it('switches provider and model together when the pick is another provider', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, providerId: 'p2', model: 'gpt-x' } as HostSessionRecord,
    }));
    const ctx = makeContext(
      { ...capabilities, update },
      { choose: async () => 'p2::gpt-x' },
    );
    const outcome = await command('model').run(ctx, '');
    expect(update.mock.calls[0]?.[2]).toEqual({ model: 'gpt-x', providerId: 'p2' });
    expect(outcome.kind).toBe('session_updated');
    expect(ctx.notices.join('\n')).toContain('Provider changed too.');
  });

  it('lists the current model first, with its window and flags', async () => {
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...capabilities, update: vi.fn() }, { choose });
    await command('model').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { label: string; description?: string }[];
    // The session's model is gpt-x: first row, marked, with pi-style units.
    expect(offered[0]?.label).toBe('gpt-x');
    expect(offered[0]?.description).toContain('Provider One');
    expect(offered[0]?.description).toContain('200k ctx');
    expect(offered[0]?.description).toContain('current');
    expect(offered[0]?.description).toContain('low/medium/high');
    expect(offered[1]?.label).toBe('gpt-xl');
    expect(offered[1]?.description).toContain('1.0M ctx');
    // The other provider's model of the same id is offered too, with its own
    // provider named — that is the whole point of reading the catalog.
    expect(offered[2]?.label).toBe('gpt-x');
    expect(offered[2]?.description).toContain('Provider Two');
  });

  it('cancelling the picker changes nothing', async () => {
    const update = vi.fn();
    const ctx = makeContext({ ...capabilities, update }, { choose: async () => null });
    const outcome = await command('model').run(ctx, '');
    expect(update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'handled' });
  });

  it('switches by name without opening the picker', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, model: 'gpt-xl' } as HostSessionRecord,
    }));
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...capabilities, update }, { choose });
    await command('model').run(ctx, 'gpt-xl');
    expect(choose).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown model and suggests close matches', async () => {
    const update = vi.fn();
    const ctx = makeContext({ ...capabilities, update });
    const outcome = await command('model').run(ctx, 'gpt-xy');
    expect(update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'handled' });
    expect(ctx.errors.join('\n')).toContain('No model matches "gpt-xy"');
    expect(ctx.errors.join('\n')).toContain('gpt-x');
  });

  it('re-reads and retries when the session changed under it', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ updated: false as const, reason: 'conflict' as const })
      .mockResolvedValueOnce({ updated: true as const, session: { ...SESSION, model: 'gpt-xl' } as HostSessionRecord });
    const get = vi.fn(async () => ({ ...SESSION, updatedAt: SESSION.updatedAt + 5 }));
    const ctx = makeContext({ ...capabilities, update, get });
    const outcome = await command('model').run(ctx, 'gpt-xl');
    expect(update).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    // The retry must carry the fresh optimistic-lock token, not the stale one.
    expect(update.mock.calls[1]?.[1]).toBe(SESSION.updatedAt + 5);
    expect(outcome.kind).toBe('session_updated');
  });

  it('refuses to switch while a turn is streaming', async () => {
    const update = vi.fn();
    const ctx = makeContext({ ...capabilities, update });
    const busy = { ...ctx, busy: true };
    await command('model').run(busy, 'gpt-xl');
    expect(update).not.toHaveBeenCalled();
    expect(ctx.errors.join('\n')).toContain('while a turn is running');
  });

  it('explains an empty catalog instead of offering an empty picker', async () => {
    const ctx = makeContext({
      getProviderCatalog: async () => ({ providers: [], configRoot: '/tmp/duya-config' }),
    });
    await command('model').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('No models are configured');
  });

  it('names the configuration file when it cannot be read', async () => {
    const ctx = makeContext({
      getProviderCatalog: async () => ({
        providers: [],
        configRoot: '/tmp/duya-config',
        error: 'No provider configuration found at /tmp/duya-config/config.toml.',
      }),
    });
    await command('model').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('/tmp/duya-config/config.toml');
  });

  it('switches by a provider-qualified name', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, providerId: 'p2', model: 'gpt-x' } as HostSessionRecord,
    }));
    const ctx = makeContext({ ...capabilities, update });
    await command('model').run(ctx, 'p2/gpt-x');
    expect(update.mock.calls[0]?.[2]).toEqual({ model: 'gpt-x', providerId: 'p2' });
  });

  /**
   * The same provider with the vendor presets the Host attaches to it.
   *
   * `enabled_models` is a hand-typed list, so a vendor with a dozen models is
   * usually configured with two. Without `presetModels` those ten are
   * unreachable from the picker, which is the report this answers.
   */
  const presetCapabilities = {
    getProviderCatalog: async () => ({
      providers: [
        {
          providerId: 'p1',
          name: 'Provider One',
          providerType: 'anthropic',
          hasApiKey: true,
          models: [
            { modelId: 'gpt-x', contextWindow: 200_000 },
            { modelId: 'gpt-xl', contextWindow: 1_000_000 },
          ],
          presetModels: [{ modelId: 'gpt-r', contextWindow: 128_000, supportsReasoning: true }],
        },
      ],
      configRoot: '/tmp/duya-config',
    }),
  };

  it('offers a preset after the configured models of its provider, flagged', async () => {
    const choose = vi.fn(async () => null);
    const ctx = makeContext({ ...presetCapabilities, update: vi.fn() }, { choose });
    await command('model').run(ctx, '');
    const offered = choose.mock.calls[0]?.[1] as readonly { label: string; description?: string }[];
    // A preset is a different promise than a configured row, so it is not
    // interleaved into it: it sorts last within its own provider.
    expect(offered.map((row) => row.label)).toEqual(['gpt-x', 'gpt-xl', 'gpt-r']);
    expect(offered[2]?.description).toContain('preset');
    expect(offered[2]?.description).toContain('reasoning');
    expect(offered[0]?.description).not.toContain('preset');
  });

  it('switches to a preset and says the configuration file was not written', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, model: 'gpt-r' } as HostSessionRecord,
    }));
    const ctx = makeContext(
      { ...presetCapabilities, update },
      { choose: async () => 'p1::gpt-r' },
    );
    const outcome = await command('model').run(ctx, '');
    expect(update.mock.calls[0]?.[2]).toEqual({ model: 'gpt-r' });
    expect(ctx.notices.join('\n')).toContain(
      'gpt-r is a Provider One preset, so it is not written into config.toml.',
    );
    expect(outcome.kind).toBe('session_updated');
  });

  it('reaches a preset by name with no picker', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, model: 'gpt-r' } as HostSessionRecord,
    }));
    const ctx = makeContext({ ...presetCapabilities, update });
    await command('model').run(ctx, 'gpt-r');
    expect(update.mock.calls[0]?.[2]).toEqual({ model: 'gpt-r' });
  });
});

describe('/usage', () => {
  it('prices the session when the Host knows the model', async () => {
    const ctx = makeContext({
      readMessages: async () => page([
        message('assistant', 'x', {
          tokenUsage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_hit_tokens: 0 },
        }),
      ]),
      getUsageIndex: async () => ({
        sessions: [],
        pricing: [
          { providerId: 'p1', modelId: 'gpt-x', inputPerMillion: 3, outputPerMillion: 6 },
        ],
      }),
    });
    await command('cost').run(ctx, '');
    const out = ctx.notices.join('\n');
    // 1M input at $3/M + 500k output at $6/M.
    expect(out).toContain('$6.00');
    expect(out).toContain('provider-reported usage counters');
  });

  it('omits the cost rather than guessing when pricing is absent', async () => {
    const ctx = makeContext({
      readMessages: async () => page([
        message('assistant', 'x', { tokenUsage: { input_tokens: 1234, output_tokens: 56 } }),
      ]),
      getUsageIndex: async () => ({ sessions: [], pricing: [] }),
    });
    await command('cost').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('unavailable');
    expect(out).not.toMatch(/\$0\.00/);
    expect(out).toContain('1.2k');
  });

  it('says so when the session has no usage yet', async () => {
    const ctx = makeContext({
      readMessages: async () => page([message('user', 'hi')]),
      getUsageIndex: async () => ({ sessions: [], pricing: [] }),
    });
    await command('cost').run(ctx, '');
    expect(ctx.notices.join('\n')).toContain('no usage recorded yet');
  });
});

describe('/context', () => {
  it('reports the ratio against the capability window and names its source', async () => {
    const ctx = makeContext({
      readMessages: async () => page([
        message('assistant', 'x', {
          tokenUsage: { input_tokens: 50_000, output_tokens: 10, cache_hit_tokens: 0 },
        }),
      ]),
      getProviderModelCapability: async () => ({
        providerId: 'p1', modelId: 'gpt-x', contextWindow: 200_000, source: 'user', updatedAt: 1,
      }),
    });
    await command('context').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toMatch(/used\s+50k/);
    expect(out).toContain('25.0% used');
    expect(out).toMatch(/remaining\s+150k/);
    expect(out).toContain('model capability');
  });

  it('falls back to the built-in catalog when the Host has no capability row', async () => {
    // The model comes from the built-in catalog itself, not from a hardcoded
    // id: the catalog is refreshed from upstream model metadata, and a
    // hardcoded id breaks the next time upstream renames a model. (It did —
    // `claude-sonnet-4` became `claude-sonnet-4-6`, and this test failed in
    // every run whose affected scope reached packages/cli.)
    const catalogModel = allProviderModels.find((model) => model.contextWindow === 1_000_000);
    if (!catalogModel) throw new Error('the built-in catalog must offer a 1M model');
    const ctx = makeContext({
      readMessages: async () => page([
        message('assistant', 'x', { tokenUsage: { input_tokens: 100_000, output_tokens: 1 } }),
      ]),
      getProviderModelCapability: async () => null,
    }, {}, { ...SESSION, model: catalogModel.id } as HostSessionRecord);
    await command('context').run(ctx, '');
    const out = ctx.notices.join('\n');
    // 1M for a catalog model — the same chain the Desktop ring and
    // auto-compaction resolve against.
    expect(out).toContain('1.0M');
    expect(out).toContain('built-in model catalog');
  });

  it('says the 200K default is a fallback, not a measurement', async () => {
    const ctx = makeContext({
      readMessages: async () => page([
        message('assistant', 'x', { tokenUsage: { input_tokens: 50_000, output_tokens: 1 } }),
      ]),
      getProviderModelCapability: async () => null,
    });
    await command('context').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('DEFAULT (200K)');
    expect(out).toContain('no capability row and no catalog entry');
  });

  it('refuses to report a ratio before any usage anchor exists', async () => {
    const ctx = makeContext({
      readMessages: async () => page([message('user', 'hi')]),
      getProviderModelCapability: async () => ({
        providerId: 'p1', modelId: 'gpt-x', contextWindow: 200_000, source: 'user', updatedAt: 1,
      }),
    });
    await command('context').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('no usage anchor yet');
    expect(out).not.toContain('% used');
  });
});

describe('/transcript', () => {
  it('counts by role and points at /export', async () => {
    const ctx = makeContext({
      readMessages: async () => page([
        message('user', 'a'),
        message('assistant', 'b'),
        message('assistant', 'c'),
        message('tool', 'd'),
      ]),
    });
    await command('transcript').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('user');
    expect(out).toMatch(/total\s+4/);
    expect(out).toMatch(/assistant\s+2/);
    expect(out).toContain('/export');
  });

  it('handles an empty session without dividing or crashing', async () => {
    const ctx = makeContext({ readMessages: async () => page([]) });
    await command('transcript').run(ctx, '');
    expect(ctx.notices.join('\n')).toContain('no messages in this session');
  });
});

describe('/export', () => {
  it('lets the Host pick the destination when none is given', async () => {
    const exportRollout = vi.fn(async () => ({ absolutePath: '/tmp/out.jsonl', lines: 12, bytes: 900 }));
    const ctx = makeContext({ exportRollout });
    await command('export').run(ctx, '');
    expect(exportRollout).toHaveBeenCalledWith('s1', undefined);
    expect(ctx.notices.join('\n')).toContain('/tmp/out.jsonl');
  });

  it('passes a real directory through and rejects a file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-slash-export-'));
    const file = join(dir, 'not-a-dir.txt');
    writeFileSync(file, 'x');

    const exportRollout = vi.fn(async () => ({ absolutePath: join(dir, 'out.jsonl'), lines: 1, bytes: 1 }));
    const ok = makeContext({ exportRollout });
    await command('export').run(ok, dir);
    expect(exportRollout).toHaveBeenCalledWith('s1', dir);

    const blocked = makeContext({ exportRollout });
    await command('export').run(blocked, file);
    expect(blocked.errors.join('\n')).toContain('Not a directory');
    expect(exportRollout).toHaveBeenCalledTimes(1); // unchanged by the rejected call
  });

  it('surfaces a Host export failure', async () => {
    const ctx = makeContext({
      exportRollout: async () => { throw new Error('disk full'); },
    });
    await command('export').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('disk full');
  });
});

describe('/status', () => {
  it('shows the identity fields the session actually has', async () => {
    const ctx = makeContext({ readMessages: async () => page([message('user', 'hi')]) });
    await command('status').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('s1');
    expect(out).toContain('gpt-x');
    expect(out).toContain('p1');
    expect(out).toContain('messages   1');
  });
});

// ������������������������������������������ session ops ������������������������������������������

describe('/rename', () => {
  it('renames with an explicit title', async () => {
    const update = vi.fn(async () => ({
      updated: true as const,
      session: { ...SESSION, title: 'Refactor plan' } as HostSessionRecord,
    }));
    const ctx = makeContext({ update });
    const outcome = await command('rename').run(ctx, 'Refactor plan');
    expect(update.mock.calls[0]?.[2]).toEqual({ title: 'Refactor plan' });
    expect(outcome.kind).toBe('session_updated');
  });

  it('asks for a title instead of opening a picker that cannot collect one', async () => {
    const update = vi.fn();
    const ctx = makeContext({ update });
    await command('rename').run(ctx, '');
    expect(update).not.toHaveBeenCalled();
    expect(ctx.errors.join('\n')).toContain('Usage: /rename <new title>');
  });
});

describe('/permission', () => {
  it('shows the stored profile as the composer mode', async () => {
    const ctx = makeContext({}, {}, { ...SESSION, permissionMode: 'full_access' } as HostSessionRecord);
    await command('permission').run(ctx, '');
    const out = ctx.notices.join('\n');
    expect(out).toContain('current  bypass');
    expect(out).toContain('/permission ask|auto|bypass');
  });

  it('maps each composer mode onto the session profile', async () => {
    const update = vi.fn(async (_id: string, _at: number, patch: { permissionMode?: string }) => ({
      updated: true as const,
      session: { ...SESSION, permissionMode: patch.permissionMode } as unknown as HostSessionRecord,
    }));
    const ctx = makeContext({ update } as never);
    await command('permission').run(ctx, 'ask');
    expect(update.mock.calls[0]?.[2]).toEqual({ permissionMode: 'default' });
    await command('permission').run(ctx, 'bypass');
    expect(update.mock.calls[1]?.[2]).toEqual({ permissionMode: 'full_access' });
  });

  it('rejects an unknown mode without touching the session', async () => {
    const update = vi.fn();
    const ctx = makeContext({ update } as never);
    await command('permission').run(ctx, 'yolo');
    expect(update).not.toHaveBeenCalled();
    expect(ctx.errors.join('\n')).toContain('ask | auto | bypass');
  });
});

describe('/fork', () => {
  const MESSAGES = [message('user', 'a'), message('assistant', 'b')];
  const FAKE_PAGE = () => page(MESSAGES);

  it('forks the whole conversation by default and adopts the copy', async () => {
    const { actions, adoptSession } = makeActions();
    const forkAt = vi.fn(async () => ({ ok: true as const, sessionId: 'forked-1', seedCount: 2 }));
    const client = { readMessages: FAKE_PAGE, forkAt } as never;
    const ctx = makeContext(client, {}, SESSION, actions);
    // Read the same projection the command reads, so the assertion is about
    // "the last message" rather than about what the projector does to ids.
    const projected = await loadSessionMessages(client as never, 's1', 'llm-visible');
    const lastId = projected[projected.length - 1]?.id;

    await command('fork').run(ctx, '');
    const input = forkAt.mock.calls[0]?.[1] as { throughMessageId: string; newSessionId: string };
    expect(lastId).toBeTruthy();
    expect(input.throughMessageId).toBe(lastId);
    expect(input.newSessionId).toBeTruthy();
    expect(adoptSession).toHaveBeenCalledWith('forked-1');
  });

  it('forks up to a named message when one is given', async () => {
    const { actions } = makeActions();
    const forkAt = vi.fn(async () => ({ ok: true as const, sessionId: 'forked-2', seedCount: 1 }));
    const ctx = makeContext({ readMessages: FAKE_PAGE, forkAt } as never, {}, SESSION, actions);
    await command('fork').run(ctx, 'msg-to-fork-through');
    expect((forkAt.mock.calls[0]?.[1] as { throughMessageId: string }).throughMessageId)
      .toBe('msg-to-fork-through');
  });

  it('refuses while a turn is streaming', async () => {
    const { actions } = makeActions();
    const forkAt = vi.fn();
    const ctx = makeContext({ forkAt } as never, {}, SESSION, actions);
    await command('fork').run({ ...ctx, busy: true }, '');
    expect(forkAt).not.toHaveBeenCalled();
  });

  it('reports a fork rejection from the Host', async () => {
    const { actions, adoptSession } = makeActions();
    const forkAt = vi.fn(async () => ({ ok: false as const, reason: 'source_archived' as const, seedCount: 0 }));
    const ctx = makeContext({ readMessages: async () => page([message('user', 'a')]), forkAt } as never, {}, SESSION, actions);
    await command('fork').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('source_archived');
    expect(adoptSession).not.toHaveBeenCalled();
  });

  it('refuses when there is no chat loop to switch sessions in', async () => {
    const ctx = makeContext({ readMessages: async () => page([message('user', 'a')]) } as never);
    await command('fork').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('needs the running chat loop');
  });
});

describe('/archive', () => {
  it('archives then starts a fresh session', async () => {
    const { actions, startFreshSession } = makeActions();
    const archive = vi.fn(async () => ({ ok: true as const, archivedSessionIds: ['s1'] }));
    const ctx = makeContext({ archive } as never, {}, SESSION, actions);
    await command('archive').run(ctx, '');
    expect(archive).toHaveBeenCalledWith('s1');
    expect(startFreshSession).toHaveBeenCalledTimes(1);
  });

  it('does not start a new session when the Host refuses', async () => {
    const { actions, startFreshSession } = makeActions();
    const archive = vi.fn(async () => ({ ok: false as const, reason: 'session_busy' as const }));
    const ctx = makeContext({ archive } as never, {}, SESSION, actions);
    await command('archive').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('session_busy');
    expect(startFreshSession).not.toHaveBeenCalled();
  });
});

describe('/delete', () => {
  it('confirms before destroying anything', async () => {
    const { actions, startFreshSession } = makeActions();
    const del = vi.fn(async () => ({ deleted: true as const }));
    const ctx = makeContext({ delete: del } as never, { choose: async () => 'cancel' }, SESSION, actions);
    await command('delete').run(ctx, '');
    expect(del).not.toHaveBeenCalled();
    expect(startFreshSession).not.toHaveBeenCalled();
    expect(ctx.notices.join('\n')).toContain('Cancelled.');
  });

  it('passes the optimistic-lock token when the user confirms', async () => {
    const { actions, startFreshSession } = makeActions();
    const del = vi.fn(async () => ({ deleted: true as const }));
    const ctx = makeContext({ delete: del } as never, { choose: async () => 'delete' }, SESSION, actions);
    await command('delete').run(ctx, '');
    expect(del).toHaveBeenCalledWith('s1', SESSION.updatedAt);
    expect(startFreshSession).toHaveBeenCalledTimes(1);
  });

  it('refuses while a turn is streaming', async () => {
    const { actions } = makeActions();
    const del = vi.fn();
    const ctx = makeContext({ delete: del } as never, {}, SESSION, actions);
    await command('delete').run({ ...ctx, busy: true }, '');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('/stop', () => {
  it('interrupts a running turn', async () => {
    const { actions, interrupt } = makeActions();
    const ctx = makeContext({}, {}, SESSION, actions);
    await command('stop').run({ ...ctx, busy: true }, '');
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing is running', async () => {
    const { actions, interrupt } = makeActions();
    const ctx = makeContext({}, {}, SESSION, actions);
    await command('stop').run(ctx, '');
    expect(interrupt).not.toHaveBeenCalled();
    expect(ctx.notices.join('\n')).toContain('No turn is running.');
  });
});

describe('/copy', () => {
  it('reports that there is nothing to copy yet', async () => {
    const ctx = makeContext({ readMessages: async () => page([message('user', 'hi')]) } as never);
    await command('copy').run(ctx, '');
    expect(ctx.errors.join('\n')).toContain('No assistant reply');
  });
});

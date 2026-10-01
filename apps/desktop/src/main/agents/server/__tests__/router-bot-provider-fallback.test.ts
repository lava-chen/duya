/**
 * router-bot-provider-fallback.test.ts — Plan 506
 *
 * Regression coverage for the "Model is required" worker crash that
 * surfaces when a bot session (`bot:<agentId>`) wakes its worker with a
 * body whose `providerConfig.model` is empty (the renderer has no active
 * provider, but the bot's `[agents.<id>]` binding does).
 *
 * The fallback helper `resolveBotProviderConfigFallback` takes its IO
 * adapters as a deps parameter (see `BotProviderConfigFallbackDeps`),
 * so we exercise it by passing in plain vi.fn()s — no `vi.mock` is
 * required because vitest only intercepts modules the test file
 * imports directly. This is cheaper than standing up the full session-
 * store / worker / provider-store / HTTP plumbing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveBotProviderConfigFallback,
  type BotProviderConfigFallbackDeps,
} from '../router';

function makeDeps(overrides: Partial<BotProviderConfigFallbackDeps> = {}): BotProviderConfigFallbackDeps & {
  readConfigAgents: ReturnType<typeof vi.fn>;
  resolveBotOrDefaultProvider: ReturnType<typeof vi.fn>;
  buildCronProviderConfig: ReturnType<typeof vi.fn>;
} {
  const readConfigAgents = overrides.readConfigAgents ?? vi.fn();
  const resolveBotOrDefaultProvider =
    overrides.resolveBotOrDefaultProvider ?? vi.fn();
  const buildCronProviderConfig =
    overrides.buildCronProviderConfig ?? vi.fn();
  return { readConfigAgents, resolveBotOrDefaultProvider, buildCronProviderConfig };
}

describe('resolveBotProviderConfigFallback (Plan 506)', () => {
  it('patches empty model with the bot binding resolved via provider store', async () => {
    const deps = makeDeps({
      readConfigAgents: vi.fn().mockResolvedValue({
        'bot-dd287a': { provider: 'minimaxi-anthropic', model: 'MiniMax-M3' },
      }),
      resolveBotOrDefaultProvider: vi.fn().mockReturnValue({
        provider: {
          apiKey: 'sk-x',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          providerType: 'anthropic',
          options: {},
        },
        model: 'MiniMax-M3',
      }),
      buildCronProviderConfig: vi.fn().mockReturnValue({
        apiKey: 'sk-x',
        baseURL: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3',
        provider: 'anthropic',
        authStyle: 'api_key',
      }),
    });

    // Body has only the bare keys — `model` empty, all other fields empty
    // (no `provider: 'openai'` here, because that would mean "body has a
    // provider" and the helper would preserve it instead of replacing).
    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      { apiKey: '', model: '', baseURL: '' },
      deps,
    );

    expect(out).toEqual({
      apiKey: 'sk-x',
      baseURL: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M3',
      provider: 'anthropic',
      authStyle: 'api_key',
    });
    expect(deps.resolveBotOrDefaultProvider).toHaveBeenCalledWith({
      provider: 'minimaxi-anthropic',
      model: 'MiniMax-M3',
    });
  });

  it('returns the input unchanged when the body already has a model (renderer choice wins)', async () => {
    const deps = makeDeps();
    const current = {
      apiKey: 'sk-renderer',
      baseURL: 'https://renderer.example/v1',
      model: 'gpt-4o',
      provider: 'openai',
      authStyle: 'api_key',
    };
    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      current,
      deps,
    );
    expect(out).toBe(current);
    expect(deps.readConfigAgents).not.toHaveBeenCalled();
    expect(deps.resolveBotOrDefaultProvider).not.toHaveBeenCalled();
  });

  it('falls back to the default provider when the bot has no binding config', async () => {
    const deps = makeDeps({
      readConfigAgents: vi.fn().mockResolvedValue({}),
      resolveBotOrDefaultProvider: vi.fn().mockReturnValue({
        provider: {
          apiKey: 'sk-default',
          baseUrl: 'https://default.example/v1',
          providerType: 'openai',
          options: {},
        },
        model: 'gpt-4o',
      }),
      buildCronProviderConfig: vi.fn().mockReturnValue({
        apiKey: 'sk-default',
        baseURL: 'https://default.example/v1',
        model: 'gpt-4o',
        provider: 'openai',
        authStyle: 'api_key',
      }),
    });

    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      undefined,
      deps,
    );

    expect(out).toEqual({
      apiKey: 'sk-default',
      baseURL: 'https://default.example/v1',
      model: 'gpt-4o',
      provider: 'openai',
      authStyle: 'api_key',
    });
    expect(deps.resolveBotOrDefaultProvider).toHaveBeenCalledWith(undefined);
  });

  it('returns the input unchanged when provider resolution throws', async () => {
    const deps = makeDeps({
      readConfigAgents: vi.fn().mockResolvedValue({
        'bot-dd287a': { provider: 'ghost-store', model: 'whatever' },
      }),
      resolveBotOrDefaultProvider: vi.fn().mockImplementation(() => {
        throw new Error('no active provider configured');
      }),
    });

    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      { model: '' },
      deps,
    );
    // Fall-through: the existing L617 guard surfaces a 400 with a clearer
    // message than a worker crash deep inside initAgent.
    expect(out).toEqual({ model: '' });
  });

  it('returns the input unchanged when readConfigAgents itself throws', async () => {
    const deps = makeDeps({
      readConfigAgents: vi.fn().mockRejectedValue(new Error('config.toml missing')),
    });
    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      { model: '' },
      deps,
    );
    expect(out).toEqual({ model: '' });
    expect(deps.resolveBotOrDefaultProvider).not.toHaveBeenCalled();
  });

  it('keeps the body apiKey/baseURL when present, only fills the empty model', async () => {
    const deps = makeDeps({
      readConfigAgents: vi.fn().mockResolvedValue({
        'bot-dd287a': { provider: 'minimaxi-anthropic', model: 'MiniMax-M3' },
      }),
      resolveBotOrDefaultProvider: vi.fn().mockReturnValue({
        provider: {
          apiKey: 'sk-from-store',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          providerType: 'anthropic',
          options: {},
        },
        model: 'MiniMax-M3',
      }),
      buildCronProviderConfig: vi.fn().mockReturnValue({
        apiKey: 'sk-from-store',
        baseURL: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3',
        provider: 'anthropic',
        authStyle: 'api_key',
      }),
    });

    // Body keeps apiKey/baseURL — fallback should NOT overwrite them.
    const out = await resolveBotProviderConfigFallback(
      'bot-dd287a',
      {
        apiKey: 'sk-body',
        baseURL: 'https://body.example/v1',
        model: '',
        provider: '',
      },
      deps,
    );

    expect(out).toEqual({
      apiKey: 'sk-body',
      baseURL: 'https://body.example/v1',
      model: 'MiniMax-M3',
      provider: 'anthropic',
      authStyle: 'api_key',
    });
  });
});
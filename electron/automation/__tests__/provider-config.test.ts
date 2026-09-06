import { describe, expect, it } from 'vitest';
import { buildCronProviderConfig } from '../provider-config';
import type { ResolvedCronProvider } from '../provider';

function mk(
  providerType: ResolvedCronProvider['provider']['providerType'],
  baseUrl: string = 'u',
): ResolvedCronProvider {
  return {
    provider: {
      id: 'p1',
      providerType,
      name: 'p1',
      apiKey: 'k',
      baseUrl,
      options: {},
    } as ResolvedCronProvider['provider'],
    model: 'm',
  };
}

describe('buildCronProviderConfig (plan 505)', () => {
  it('maps providerType to LLM provider and passes fields through', () => {
    expect(buildCronProviderConfig(mk('anthropic'))).toEqual({
      apiKey: 'k',
      baseURL: 'u',
      model: 'm',
      provider: 'anthropic',
      authStyle: 'api_key',
    });
  });

  it('does NOT map localhost:11434 to ollama (call sites do not thread baseUrl to toLLMProvider)', () => {
    // Existing behaviour: all five call sites invoke `toLLMProvider(providerType)`
    // with a single argument, so the baseUrl-driven ollama branch in
    // provider-types.ts never fires. Kept faithful for a behavior-preserving
    // refactor; threading baseUrl here would be a behavior change.
    expect(buildCronProviderConfig(mk('openai', 'http://localhost:11434')).provider).toBe('openai');
  });

  it('maps openai providerType to openai', () => {
    expect(buildCronProviderConfig(mk('openai')).provider).toBe('openai');
  });

  it('normalises missing apiKey to "" (db-bridge callers pass possibly-undefined keys)', () => {
    const r = mk('openai');
    r.provider.apiKey = undefined as unknown as string;
    expect(buildCronProviderConfig(r).apiKey).toBe('');
  });
});
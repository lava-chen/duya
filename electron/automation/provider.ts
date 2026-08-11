/**
 * electron/automation/provider.ts
 *
 * Provider + model resolution for cron runs, aligned with chat: fall back to
 * the first configured provider when no soft default is set. A cron job's
 * `model` may be empty or the legacy placeholder 'default' (the UI stored it
 * before a concrete model was picked) — both resolve to the provider's default
 * model so stale cron jobs keep running instead of failing on every run.
 */

import { getProviderStore } from '../services/providers/provider-store-electron';
import { toLegacyApiProvider } from '../../src/lib/providers/legacy';
import type { ApiProvider } from '../../src/lib/providers/types';

export interface ResolvedCronProvider {
  provider: ApiProvider;
  model: string;
}

/**
 * Resolve the active LLM provider + model for a cron run.
 * Throws 'no active provider configured' when no provider exists at all.
 */
export function resolveCronProvider(jobModel?: string): ResolvedCronProvider {
  const store = getProviderStore();
  const p = store.getDefaultLlmProvider() ?? store.listLlmProviders()[0];
  const provider = p ? toLegacyApiProvider(p) : undefined;
  if (!provider) throw new Error('no active provider configured');
  const model = resolveCronModel(jobModel, provider);
  if (!model) throw new Error('cron model is not configured');
  return { provider, model };
}

function resolveCronModel(jobModel: string | undefined, provider: ApiProvider): string {
  const explicit = jobModel?.trim() ?? '';
  if (explicit && explicit.toLowerCase() !== 'default') return explicit;

  const opts = provider.options ?? {};
  const fromOptions =
    (typeof opts.defaultModel === 'string' ? opts.defaultModel : '') ||
    (typeof opts.model === 'string' ? opts.model : '') ||
    (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0
      ? String(opts.enabled_models[0])
      : '');
  if (fromOptions) return fromOptions;

  switch (provider.providerType) {
    case 'ollama':
      return 'llama3.2';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'claude-sonnet-4-20250514';
    default:
      return 'gpt-4o';
  }
}

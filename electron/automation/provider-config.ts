/**
 * electron/automation/provider-config.ts
 *
 * Pure mapper from a resolved provider to the agent-server Chat API's
 * providerConfig shape. Extracted so agent-run / wake-run / db-bridge stop
 * hand-building the same five-field object in five places (plan 505 Part A).
 *
 * Imports only the pure `toLLMProvider` and types — no electron — so this
 * module is unit-testable under vitest/node.
 */

import { toLLMProvider } from '../config/provider-types';
import type { ApiProvider } from '../../src/lib/providers/types';
import type { CompactModelConfig } from '../../packages/agent/src/types';
import type { ResolvedCronProvider } from './provider';

export interface CronProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: string;
  authStyle: 'api_key';
  /**
   * Dedicated summarization model (renderer parity) — optional so pure
   * builders stay unchanged; agent-run injects it for every main-side run.
   */
  compactModelConfig?: CompactModelConfig;
}

/**
 * Resolve the model to run a job with. An explicit non-'default' value wins;
 * otherwise fall back to the provider's configured default model, and finally
 * to a provider-type-specific default. Mirrors the chat path so cron/bot runs
 * keep behaving like ad-hoc chats. Pure — no electron, no I/O.
 */
export function resolveCronModel(jobModel: string | undefined, provider: ApiProvider): string {
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

export function buildCronProviderConfig(r: ResolvedCronProvider): CronProviderConfig {
  return {
    // Normalise to the coalescing the call sites already do: apiKey is a
    // required `string` on the DTO, but db-bridge passes possibly-undefined
    // keys and currently coalesces with `?? ''` / `|| undefined`.
    apiKey: r.provider.apiKey ?? '',
    baseURL: r.provider.baseUrl || undefined,
    model: r.model,
    provider: toLLMProvider(r.provider.providerType),
    authStyle: 'api_key',
  };
}
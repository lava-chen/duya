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
import type { ResolvedCronProvider } from './provider';

export interface CronProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: string;
  authStyle: 'api_key';
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
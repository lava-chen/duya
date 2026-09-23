/**
 * electron/automation/compact-config.ts
 *
 * Main-side read of the configured compact (summarization) model — the same
 * `auxiliary.compact` settings the renderer injects into interactive chat
 * runs. Grok parity: a dedicated summarization model applies to EVERY run
 * path, not only interactive chats; wake/cron/bot runs previously fell back
 * to the run's own model, so background compaction silently diverged from
 * the interactive compaction config.
 *
 * Pure mapping — no electron imports — so it stays unit-testable.
 */

import { getConfigStore } from '../config/store-instance';
import type { CompactModelConfig } from '../../packages/agent/src/types';

export function resolveCompactModelConfig(): CompactModelConfig | undefined {
  try {
    const raw = getConfigStore().getByPath('auxiliary.compact') as
      | Partial<Record<'provider' | 'model' | 'baseUrl' | 'baseURL' | 'apiKey' | 'enabled', string | boolean>>
      | undefined;
    if (!raw?.enabled) return undefined;
    if (typeof raw.model !== 'string' || !raw.model) return undefined;
    if (typeof raw.provider !== 'string' || !raw.provider) return undefined;
    const baseURL =
      (typeof raw.baseURL === 'string' && raw.baseURL) ||
      (typeof raw.baseUrl === 'string' && raw.baseUrl) ||
      '';
    return {
      provider: raw.provider,
      model: raw.model,
      baseURL,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      enabled: true,
    };
  } catch {
    // Config store unavailable (early boot / tests) — fall back silently.
    return undefined;
  }
}

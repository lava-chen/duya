/**
 * apps/desktop/src/main/automation/provider.ts
 *
 * Provider + model resolution for cron runs, aligned with chat: fall back to
 * the first configured provider when no soft default is set. A cron job's
 * `model` may be empty or the legacy placeholder 'default' (the UI stored it
 * before a concrete model was picked) — both resolve to the provider's default
 * model so stale cron jobs keep running instead of failing on every run.
 */

import { getProviderStore } from '../services/providers/provider-store-electron';
import { toLegacyApiProvider } from '../../renderer/lib/providers/legacy';
import { resolveCronModel } from './provider-config';
import type { ApiProvider } from '../../renderer/lib/providers/types';

export interface ResolvedCronProvider {
  provider: ApiProvider;
  model: string;
}

/**
 * Resolve the underlying LLM provider — by provider store id when given
 * (a bot's own provider), else the default / first configured. Throws
 * 'no active provider configured' when no provider exists at all.
 */
function resolveLlmProvider(providerId?: string): ApiProvider {
  const store = getProviderStore();
  const p = providerId
    ? (store.getLlmProvider(providerId) ??
      store.getDefaultLlmProvider() ??
      store.listLlmProviders()[0])
    : (store.getDefaultLlmProvider() ?? store.listLlmProviders()[0]);
  const provider = p ? toLegacyApiProvider(p) : undefined;
  if (!provider) throw new Error('no active provider configured');
  return provider;
}

/**
 * Resolve the active LLM provider + model for a cron run.
 *
 * `providerId` is the routine's own pin (`AutomationCron.modelProviderId`).
 * Forwarded so a routine pinned to one vendor's model resolves against THAT
 * provider instead of the default, which matters as soon as two providers
 * offer the same model name. Unset keeps the pre-existing behaviour (default
 * provider). The model itself is never encoded with the provider: it is
 * returned verbatim, so an unknown id degrades to "wrong vendor, right
 * model" rather than a bogus model name.
 *
 * Throws 'no active provider configured' when no provider exists at all.
 */
export function resolveCronProvider(jobModel?: string, providerId?: string | null): ResolvedCronProvider {
  const provider = resolveLlmProvider(providerId ?? undefined);
  const model = resolveCronModel(jobModel, provider);
  if (!model) throw new Error('cron model is not configured');
  return { provider, model };
}

/**
 * Resolve the provider + model for a bot wake run. Uses the bot's own
 * provider store id when present (falling back to the default provider),
 * honoring its `model`; a missing provider falls back to the default, so a
 * bot without an override wakes exactly like a cron run.
 */
export function resolveBotWakeProvider(
  providerId: string | undefined,
  model?: string,
): ResolvedCronProvider {
  const provider = resolveLlmProvider(providerId);
  const resolvedModel = resolveCronModel(model, provider);
  if (!resolvedModel) throw new Error('bot wake model is not configured');
  return { provider, model: resolvedModel };
}

/**
 * Derive the agent id from a persistent bot session id (`bot:<agentId>`).
 * Returns undefined for non-bot sessions. Central so every wake/run entry
 * (DM, channel, user-turn fallback) picks up the bot's own provider/model
 * without requiring the caller to thread the id through.
 */
export function botAgentIdFromSession(sessionId: string): string | undefined {
  const PREFIX = 'bot:';
  return sessionId.startsWith(PREFIX) ? sessionId.slice(PREFIX.length) : undefined;
}

/**
 * Resolve provider + model for an agent run: when the bot config (its own
 * provider/model) is present, honor it; otherwise fall back to the generic
 * cron resolution. `bot` is the agent's `[agents.<id>]` entry, already keyed by
 * the resolved agent id by the caller.
 */
export function resolveBotOrDefaultProvider(
  bot: { provider?: string; model?: string } | undefined,
  fallbackModel?: string,
): ResolvedCronProvider {
  return bot
    ? resolveBotWakeProvider(bot.provider, bot.model)
    : resolveCronProvider(fallbackModel);
}

/**
 * electron/services/next-step/next-step-service.ts
 *
 * Next-step suggestions: after an agent turn finishes, predict 3 short
 * follow-up prompts the user would plausibly send. Modeled on the recap
 * service — reads durable messages from the core store, picks the default
 * LLM provider, makes one non-streaming call, parses strict JSON.
 *
 * Stateless by design: the renderer drives when to ask (streaming
 * true → false transition), this module only answers.
 */

import { getCoreStoresOrNull } from '../../db/core-connection';
import { storedEventsToIpcMessages } from '../../ipc/core-db-adapters';
import { getProviderStore } from '../providers/provider-store-electron';
import { buildNextStepPrompt, parseNextStepSuggestions } from './next-step-prompt';
import { callLLMForNextSteps } from './next-step-llm';

export async function requestNextSteps(sessionId: string): Promise<string[]> {
  const stores = getCoreStoresOrNull();
  if (!stores) {
    return [];
  }

  const events = stores.messageLog.listBySession(sessionId);
  const messages = storedEventsToIpcMessages(events);
  if (messages.length === 0) {
    return [];
  }

  // Nothing to suggest a follow-up for until the agent has replied once.
  if (!messages.some((m) => m.role === 'assistant')) {
    return [];
  }

  const store = getProviderStore();
  const provider = store.getDefaultLlmProvider();
  if (!provider) {
    return [];
  }

  // Same model fallback chain as RecapService.generateRecap: explicit
  // default model → provider model → first enabled model.
  const model =
    (provider.options?.defaultModel as string) ||
    (provider.options?.model as string) ||
    (Array.isArray(provider.options?.enabled_models) &&
      (provider.options?.enabled_models as string[])[0]) ||
    '';
  const runtime = store.getProviderRuntimeConfig(provider.id, model);
  if ('error' in runtime) {
    return [];
  }

  const { systemPrompt, userContent } = buildNextStepPrompt(messages);
  const raw = await callLLMForNextSteps(runtime, systemPrompt, userContent);
  return parseNextStepSuggestions(raw);
}

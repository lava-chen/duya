import { ModelsError } from '../auth/error.js';
import type { CredentialStore } from '../auth/types.js';
import type { Model, SSEEvent } from '../types.js';
import type { Provider } from './types.js';

export interface Models {
  register(provider: Provider): void;
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;
  getModels(provider?: string): readonly Model[];
  getModel(provider: string, id: string): Model | undefined;
  getAuth(
    providerId: string,
  ): Promise<{ apiKey?: string; baseUrl?: string; source?: string } | undefined>;
  stream(
    providerId: string,
    model: Model,
    options: { messages: unknown[]; systemPrompt?: string },
  ): AsyncGenerator<SSEEvent, unknown, unknown>;
}

export interface CreateModelsOptions {
  providers?: readonly Provider[];
  credentials?: CredentialStore;
}

/** A collection of providers, with model lookup and stream dispatch. */
export function createModels(options: CreateModelsOptions = {}): Models {
  const providers = new Map<string, Provider>();
  const { credentials } = options;
  for (const provider of options.providers ?? []) providers.set(provider.id, provider);

  return {
    register: (provider) => {
      providers.set(provider.id, provider);
    },
    getProviders: () => Array.from(providers.values()),
    getProvider: (id) => providers.get(id),
    getModels: (provider) => {
      if (provider) return providers.get(provider)?.getModels() ?? [];
      return Array.from(providers.values()).flatMap((p) => [...p.getModels()]);
    },
    getModel: (provider, id) =>
      providers.get(provider)?.getModels().find((m) => m.id === id),
    getAuth: async (providerId) => {
      const provider = providers.get(providerId);
      if (!provider) return undefined;
      const stored = await credentials?.get(providerId);
      if (stored?.type === 'oauth') return { baseUrl: provider.baseUrl, source: 'oauth' };
      if (stored?.type === 'api_key') {
        return { apiKey: stored.apiKey, baseUrl: provider.baseUrl, source: 'stored' };
      }
      return undefined;
    },
    stream: (providerId, model, streamOptions) => {
      const provider = providers.get(providerId);
      if (!provider) throw new ModelsError('provider', `Unknown provider "${providerId}"`);
      return provider.stream(model, streamOptions);
    },
  };
}
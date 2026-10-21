import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { openrouterModels } from './openrouter.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const openrouter = createProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: envApiKeyAuth('OpenRouter API Key', ['OPENROUTER_API_KEY']),
  models: openrouterModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'https://openrouter.ai/api/v1', model: '', apiFormat: 'openai-chat', providerId: 'openrouter' }),
});
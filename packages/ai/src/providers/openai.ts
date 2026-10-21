import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { openAIModels } from './openai.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const openai = createProvider({
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  auth: envApiKeyAuth('OpenAI API Key', ['OPENAI_API_KEY']),
  models: openAIModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'https://api.openai.com/v1', model: '', apiFormat: 'openai-chat', providerId: 'openai' }),
});
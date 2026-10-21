import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { kimiModels } from './kimi.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const kimi = createProvider<'openai-chat'>({
  id: 'kimi',
  name: 'Kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  auth: envApiKeyAuth('MOONSHOT_API_KEY', ['MOONSHOT_API_KEY']),
  models: kimiModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'https://api.moonshot.cn/v1', model: '', apiFormat: 'openai-chat', providerId: 'kimi' }),
});
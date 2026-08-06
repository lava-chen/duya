import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { deepseekModels } from './deepseek.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const deepseek = createProvider<'openai-chat'>({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  auth: envApiKeyAuth('DEEPSEEK_API_KEY', ['DEEPSEEK_API_KEY']),
  models: deepseekModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'https://api.deepseek.com/v1', model: '', apiFormat: 'openai-chat', providerId: 'deepseek' }),
});
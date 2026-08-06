import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { qwenModels } from './qwen.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const qwen = createProvider<'openai-chat'>({
  id: 'qwen',
  name: 'Qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  auth: envApiKeyAuth('DASHSCOPE_API_KEY', ['DASHSCOPE_API_KEY']),
  models: qwenModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', apiFormat: 'openai-chat', providerId: 'qwen' }),
});
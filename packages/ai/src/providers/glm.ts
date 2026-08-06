import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { glmModels, glmAnthropicModels } from './glm.models.js';
import { anthropicStreams, openAICompletionsStreams } from './adapters.js';

export const glm = createProvider({
  id: 'glm',
  name: 'GLM',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  auth: envApiKeyAuth('ZAI_API_KEY', ['ZAI_API_KEY']),
  models: [...glmModels, ...glmAnthropicModels] as Model[],
  api: {
    'openai-chat': openAICompletionsStreams({ apiKey: '', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: '', apiFormat: 'openai-chat', providerId: 'glm' }),
    'anthropic': anthropicStreams({ apiKey: '', baseURL: 'https://open.bigmodel.cn/api/anthropic', model: '', apiFormat: 'anthropic', providerId: 'glm' }),
  },
});
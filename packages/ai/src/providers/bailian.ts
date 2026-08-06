import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { bailianModels } from './bailian.models.js';
import { anthropicStreams } from './adapters.js';

export const bailian = createProvider({
  id: 'bailian',
  name: 'Bailian',
  baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  auth: envApiKeyAuth('DASHSCOPE_API_KEY', ['DASHSCOPE_API_KEY']),
  models: bailianModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', model: '', apiFormat: 'anthropic', providerId: 'bailian' }),
});
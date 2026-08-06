import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { volcengineModels } from './volcengine.models.js';
import { anthropicStreams } from './adapters.js';

export const volcengine = createProvider({
  id: 'volcengine',
  name: 'Volcengine',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  auth: envApiKeyAuth('ARK_API_KEY', ['ARK_API_KEY']),
  models: volcengineModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: '', apiFormat: 'anthropic', providerId: 'volcengine' }),
});
import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { xaiModels } from './xai.models.js';
import { anthropicStreams } from './adapters.js';

export const xai = createProvider({
  id: 'xai',
  name: 'xAI',
  baseUrl: 'https://api.x.ai/v1',
  auth: envApiKeyAuth('xAI API Key', ['XAI_API_KEY']),
  models: xaiModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://api.x.ai/v1', model: '', apiFormat: 'anthropic', providerId: 'xai' }),
});
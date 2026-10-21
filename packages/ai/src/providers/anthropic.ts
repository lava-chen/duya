import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { anthropicModels } from './anthropic.models.js';
import { anthropicStreams } from './adapters.js';

export const anthropic = createProvider<'anthropic'>({
  id: 'anthropic',
  name: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  auth: envApiKeyAuth('ANTHROPIC_API_KEY', ['ANTHROPIC_API_KEY']),
  models: anthropicModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic', providerId: 'anthropic' }),
});
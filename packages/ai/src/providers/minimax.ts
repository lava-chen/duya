import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { minimaxModels } from './minimax.models.js';
import { anthropicStreams } from './adapters.js';

export const minimax = createProvider({
  id: 'minimax',
  name: 'MiniMax',
  baseUrl: 'https://api.minimax.io/anthropic',
  auth: envApiKeyAuth('MINIMAX_API_KEY', ['MINIMAX_API_KEY']),
  models: minimaxModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://api.minimax.io/anthropic', model: '', apiFormat: 'anthropic', providerId: 'minimax' }),
});
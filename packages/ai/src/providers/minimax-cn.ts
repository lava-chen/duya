import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { minimaxCnModels } from './minimax-cn.models.js';
import { anthropicStreams } from './adapters.js';

export const minimaxCn = createProvider({
  id: 'minimax-cn',
  name: 'MiniMax CN',
  baseUrl: 'https://api.minimaxi.com/anthropic',
  auth: envApiKeyAuth('MINIMAX_CN_API_KEY', ['MINIMAX_CN_API_KEY']),
  models: minimaxCnModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://api.minimaxi.com/anthropic', model: '', apiFormat: 'anthropic', providerId: 'minimax-cn' }),
});
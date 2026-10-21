import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { openaiResponsesModels } from './openai-responses.models.js';
import { openAIResponsesStreams } from './adapters.js';

export const openaiResponses = createProvider({
  id: 'openai-responses',
  name: 'OpenAI Responses',
  baseUrl: 'https://api.openai.com/v1',
  auth: envApiKeyAuth('OpenAI API Key', ['OPENAI_API_KEY']),
  models: openaiResponsesModels,
  api: openAIResponsesStreams({ apiKey: '', baseURL: 'https://api.openai.com/v1', model: '', apiFormat: 'openai-responses', providerId: 'openai-responses' }),
});
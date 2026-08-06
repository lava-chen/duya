import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { ollamaModels } from './ollama.models.js';
import { openAICompletionsStreams } from './adapters.js';

export const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: {},
  models: ollamaModels,
  api: openAICompletionsStreams({ apiKey: '', baseURL: 'http://localhost:11434/v1', model: '', apiFormat: 'openai-chat', providerId: 'ollama' }),
});
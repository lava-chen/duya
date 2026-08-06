// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const ollamaModels: Model<'openai-chat'>[] = [
  {
    id: 'llama3.2',
    name: 'Llama 3.2',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
  },
];
// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
import type { Model } from '../types.js';

export const openrouterModels: Model<'openai-chat'>[] = [
  {
    id: 'auto',
    name: 'OpenRouter Auto',
    api: 'openai-chat',
    providerId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 4096,
  },
];
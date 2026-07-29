/**
 * MiniMax via OpenAI-compatible API.
 * Uses reasoning_content field for thinking output.
 */
import type { Model } from '../types.js';

export const minimaxOpenAIModels: Model<'openai-chat'>[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 (OpenAI)',
    api: 'openai-chat',
    providerId: 'minimax-openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { openAIThinkingFormat: 'reasoning-content' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
];

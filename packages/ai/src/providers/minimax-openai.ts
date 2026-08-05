/**
 * MiniMax via OpenAI-compatible API.
 * Default responses embed thinking in <think>...</think> tags inside the
 * content field. Set reasoning_split=true to get reasoning_content instead.
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
    compat: { openAIThinkingFormat: 'think-tag-fallback' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
];

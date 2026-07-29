export { minimaxAnthropicModels } from './minimax-anthropic.js';
export { minimaxOpenAIModels } from './minimax-openai.js';
export { deepseekModels } from './deepseek.js';
export { qwenModels } from './qwen.js';
export { glmModels } from './glm.js';
export { kimiModels } from './kimi.js';
export { openAIModels } from './openai.js';
export { anthropicModels } from './anthropic.js';
export { openrouterModels } from './openrouter.js';
export { ollamaModels } from './ollama.js';

import type { Model } from '../types.js';
import { minimaxAnthropicModels } from './minimax-anthropic.js';
import { minimaxOpenAIModels } from './minimax-openai.js';
import { deepseekModels } from './deepseek.js';
import { qwenModels } from './qwen.js';
import { glmModels } from './glm.js';
import { kimiModels } from './kimi.js';
import { openAIModels } from './openai.js';
import { anthropicModels } from './anthropic.js';
import { openrouterModels } from './openrouter.js';
import { ollamaModels } from './ollama.js';

export const allProviderModels: Model[] = [
  ...minimaxAnthropicModels,
  ...minimaxOpenAIModels,
  ...deepseekModels,
  ...qwenModels,
  ...glmModels,
  ...kimiModels,
  ...openAIModels,
  ...anthropicModels,
  ...openrouterModels,
  ...ollamaModels,
];

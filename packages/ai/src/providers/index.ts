export { minimaxAnthropicModels } from './minimax-anthropic.js';
export { minimaxOpenAIModels } from './minimax-openai.js';
export { deepseekModels } from './deepseek.js';
export { qwenModels } from './qwen.js';
export { glmModels, glmAnthropicModels } from './glm.js';
export { kimiModels } from './kimi.js';
export { openAIModels } from './openai.js';
export { openaiResponsesModels } from './openai-responses.js';
export { anthropicModels } from './anthropic.js';
export { openrouterModels } from './openrouter.js';
export { ollamaModels } from './ollama.js';
export { xaiModels } from './xai.js';
export { stepfunModels } from './stepfun.js';
export { volcengineModels } from './volcengine.js';
export { bailianModels } from './bailian.js';

import type { Model } from '../types.js';
import { minimaxAnthropicModels } from './minimax-anthropic.js';
import { minimaxOpenAIModels } from './minimax-openai.js';
import { deepseekModels } from './deepseek.js';
import { qwenModels } from './qwen.js';
import { glmModels, glmAnthropicModels } from './glm.js';
import { kimiModels } from './kimi.js';
import { openAIModels } from './openai.js';
import { openaiResponsesModels } from './openai-responses.js';
import { anthropicModels } from './anthropic.js';
import { openrouterModels } from './openrouter.js';
import { ollamaModels } from './ollama.js';
import { xaiModels } from './xai.js';
import { stepfunModels } from './stepfun.js';
import { volcengineModels } from './volcengine.js';
import { bailianModels } from './bailian.js';

export const allProviderModels: Model[] = [
  ...minimaxAnthropicModels,
  ...minimaxOpenAIModels,
  ...deepseekModels,
  ...qwenModels,
  ...glmModels,
  ...glmAnthropicModels,
  ...kimiModels,
  ...openAIModels,
  ...openaiResponsesModels,
  ...anthropicModels,
  ...openrouterModels,
  ...ollamaModels,
  ...xaiModels,
  ...stepfunModels,
  ...volcengineModels,
  ...bailianModels,
];

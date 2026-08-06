// Provider model data (`.models.ts`) and createProvider factory defs (`.ts`).
// `allProviderModels` is kept for backward compatibility with the compat
// resolution in `src/models.ts`.

// ─── Model data ───
export { minimaxModels } from './minimax.models.js';
export { minimaxCnModels } from './minimax-cn.models.js';
export { deepseekModels } from './deepseek.models.js';
export { qwenModels } from './qwen.models.js';
export { glmModels, glmAnthropicModels } from './glm.models.js';
export { kimiModels } from './kimi.models.js';
export { openAIModels } from './openai.models.js';
export { openaiResponsesModels } from './openai-responses.models.js';
export { anthropicModels } from './anthropic.models.js';
export { openrouterModels } from './openrouter.models.js';
export { ollamaModels } from './ollama.models.js';
export { xaiModels } from './xai.models.js';
export { stepfunModels } from './stepfun.models.js';
export { volcengineModels } from './volcengine.models.js';
export { bailianModels } from './bailian.models.js';

import type { Model } from '../types.js';
import { minimaxModels } from './minimax.models.js';
import { minimaxCnModels } from './minimax-cn.models.js';
import { deepseekModels } from './deepseek.models.js';
import { qwenModels } from './qwen.models.js';
import { glmModels, glmAnthropicModels } from './glm.models.js';
import { kimiModels } from './kimi.models.js';
import { openAIModels } from './openai.models.js';
import { openaiResponsesModels } from './openai-responses.models.js';
import { anthropicModels } from './anthropic.models.js';
import { openrouterModels } from './openrouter.models.js';
import { ollamaModels } from './ollama.models.js';
import { xaiModels } from './xai.models.js';
import { stepfunModels } from './stepfun.models.js';
import { volcengineModels } from './volcengine.models.js';
import { bailianModels } from './bailian.models.js';

export const allProviderModels: Model[] = [
  ...minimaxModels,
  ...minimaxCnModels,
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
import { createModels } from './models.js';
import type { Provider } from './types.js';
// Provider factory defs.
import { anthropic } from './anthropic.js';
import { deepseek } from './deepseek.js';
import { qwen } from './qwen.js';
import { glm } from './glm.js';
import { kimi } from './kimi.js';
import { openai } from './openai.js';
import { openaiResponses } from './openai-responses.js';
import { openrouter } from './openrouter.js';
import { ollama } from './ollama.js';
import { xai } from './xai.js';
import { stepfun } from './stepfun.js';
import { volcengine } from './volcengine.js';
import { bailian } from './bailian.js';
import { minimax } from './minimax.js';
import { minimaxCn } from './minimax-cn.js';

/** Every built-in provider factory def. */
export const allProviders: readonly Provider[] = [
  anthropic,
  deepseek,
  qwen,
  glm,
  kimi,
  openai,
  openaiResponses,
  openrouter,
  ollama,
  xai,
  stepfun,
  volcengine,
  bailian,
  minimax,
  minimaxCn,
];

/** Build a Models collection over all built-in providers. */
export function createAllModels() {
  return createModels({ providers: allProviders });
}
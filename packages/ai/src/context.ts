/**
 * @duya/ai/context — SDK-free context accounting surface.
 *
 * ## Why this subpath exists
 *
 * The main `@duya/ai` entry statically re-exports the Anthropic and OpenAI
 * protocol adapters, so importing it loads both provider SDKs. The context
 * estimators and the model catalog that back them are pure data + pure
 * functions — a Host-backed CLI or a status line that only wants to print
 * "how full is this session's context" must not pay for two SDKs to get
 * there.
 *
 * Consumers that DO talk to a provider should keep importing `@duya/ai`.
 * Consumers that only read context numbers import `@duya/ai/context`.
 *
 * Everything re-exported here is safe for that second audience: no client
 * factory, no streaming adapter, no credential store.
 */

export {
  computeContextEstimate,
  estimateMessageTokens as estimateContextMessageTokens,
  estimateTextTokens as estimateContextTextTokens,
  normalizePromptTokens,
  computeContextComposition,
  contextPartsTotal,
  IMAGE_TOKEN_FLOOR,
  CJK_CHARS_PER_TOKEN,
  ASCII_CHARS_PER_TOKEN,
  type ContextUsageBlock,
  type ContextEstimateMessage,
  type ContextEstimateOptions,
  type ContextEstimate,
  type ContextPart,
  type ContextComposition,
  type ContextCompositionOptions,
} from './utils/context-estimate.js';

export {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  type ContextWindowSource,
  type ResolvedContextWindow,
} from './utils/context-window.js';

export { findModelById } from './models.js';
export { allProviderModels } from './providers/index.js';

export type { Model, ModelCost, ModelCostRates } from './types.js';

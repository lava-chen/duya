/**
 * packages/ai/src/utils/simple-options.ts
 *
 * Shared capability helpers used by all API protocol implementations.
 * Keeps model compat logic in one place so protocol files stay thin.
 */

import type { Model } from '../types.js';

/**
 * Returns true if thinking should be disabled for this model.
 * Non-reasoning models always have thinking disabled.
 */
export function shouldDisableThinking(model: Model): boolean {
  return !model.reasoning;
}

/**
 * Returns the max output tokens, capped at the model's limit.
 * If userMax is undefined, 0, or negative, uses model.maxTokens.
 */
export function getMaxOutputTokens(model: Model, userMax?: number): number {
  if (typeof userMax !== 'number' || userMax <= 0) {
    return model.maxTokens;
  }
  return Math.min(userMax, model.maxTokens);
}

/**
 * Returns the temperature, respecting model.compat.fixedTemperature.
 * If the model has a fixed temperature, it always wins over userTemp.
 */
export function getTemperature(model: Model, userTemp?: number): number | undefined {
  if (model.compat?.fixedTemperature !== undefined) {
    return model.compat.fixedTemperature;
  }
  return userTemp;
}

/**
 * Validates and normalizes budget parameters.
 *
 * - `totalOutputBudget` takes precedence over `maxOutputTokens` / `maxTokens`
 *   when resolving the effective total.
 * - Throws if `reasoningBudget >= total` (Anthropic requires
 *   `budget_tokens < max_tokens`).
 * - Returns undefined if no budgets are set.
 */
export function validateBudgets(options: {
  reasoningBudget?: number;
  totalOutputBudget?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
}): { reasoningBudget?: number; totalOutputBudget?: number } | undefined {
  const { reasoningBudget, totalOutputBudget, maxOutputTokens, maxTokens } = options;

  // Normalize: if totalOutputBudget not set but maxOutputTokens/maxTokens is, use that.
  const total = totalOutputBudget ?? maxOutputTokens ?? maxTokens;
  if (!reasoningBudget && !total) return undefined;

  if (reasoningBudget && total && reasoningBudget >= total) {
    throw new Error(
      `reasoningBudget (${reasoningBudget}) must be less than totalOutputBudget (${total})`,
    );
  }

  return {
    reasoningBudget: reasoningBudget && reasoningBudget > 0 ? reasoningBudget : undefined,
    totalOutputBudget: total && total > 0 ? total : undefined,
  };
}

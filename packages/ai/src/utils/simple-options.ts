/**
 * packages/ai/src/utils/simple-options.ts
 *
 * Shared capability helpers used by all API protocol implementations.
 * Keeps model compat logic in one place so protocol files stay thin.
 */

import type { Model, ParameterDiagnostic } from '../types.js';

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

/**
 * Collect diagnostics for parameters that were silently adjusted or ignored.
 * Call this after resolving all options to report what was changed.
 */
export function collectDiagnostics(
  model: Model,
  userInput: {
    effort?: string;
    temperature?: number;
    maxOutputTokens?: number;
    reasoningBudget?: number;
    totalOutputBudget?: number;
  },
): ParameterDiagnostic[] {
  const diagnostics: ParameterDiagnostic[] = [];
  const routeId = `${model.providerId}/${model.id}`;

  // PARAMETER_UNSUPPORTED: effort on non-reasoning model
  if (userInput.effort && shouldDisableThinking(model)) {
    diagnostics.push({
      code: 'PARAMETER_UNSUPPORTED',
      parameter: 'effort',
      routeId,
      message: `Model ${model.id} does not support reasoning; effort parameter ignored.`,
    });
  }

  // PARAMETER_IGNORED: temperature overridden by fixedTemperature
  if (userInput.temperature !== undefined && model.compat?.fixedTemperature !== undefined) {
    diagnostics.push({
      code: 'PARAMETER_IGNORED',
      parameter: 'temperature',
      routeId,
      message: `Model ${model.id} requires fixed temperature ${model.compat.fixedTemperature}; user-specified temperature ignored.`,
    });
  }

  // PARAMETER_IGNORED: maxOutputTokens capped
  if (userInput.maxOutputTokens && userInput.maxOutputTokens > model.maxTokens) {
    diagnostics.push({
      code: 'PARAMETER_IGNORED',
      parameter: 'maxOutputTokens',
      routeId,
      message: `maxOutputTokens (${userInput.maxOutputTokens}) exceeds model limit (${model.maxTokens}); capped to ${model.maxTokens}.`,
    });
  }

  // PARAMETER_IGNORED: reasoningBudget on OpenAI (reasoning_effort controls it)
  if (userInput.reasoningBudget && model.api === 'openai-chat') {
    diagnostics.push({
      code: 'PARAMETER_IGNORED',
      parameter: 'reasoningBudget',
      routeId,
      message: `reasoningBudget is not used by OpenAI-compatible APIs; reasoning_effort controls the budget implicitly.`,
    });
  }

  // PARAMETER_REJECTED: parameters in rejectedParameters list
  if (model.compat?.rejectedParameters) {
    for (const param of model.compat.rejectedParameters) {
      if (param in userInput && userInput[param as keyof typeof userInput] !== undefined) {
        diagnostics.push({
          code: 'PARAMETER_REJECTED',
          parameter: param,
          routeId,
          message: `Model ${model.id} rejects parameter '${param}'.`,
        });
      }
    }
  }

  // PARAMETER_IGNORED: parameters in ignoredParameters list
  if (model.compat?.ignoredParameters) {
    for (const param of model.compat.ignoredParameters) {
      if (param in userInput && userInput[param as keyof typeof userInput] !== undefined) {
        diagnostics.push({
          code: 'PARAMETER_IGNORED',
          parameter: param,
          routeId,
          message: `Model ${model.id} ignores parameter '${param}'.`,
        });
      }
    }
  }

  return diagnostics;
}

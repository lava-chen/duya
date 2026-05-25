/**
 * Multimodal detection — determines if a model likely supports image inputs.
 *
 * Mirrors hermes-agent design: when the main model doesn't support multimodal,
 * image content blocks are omitted and only text descriptions from the vision
 * model are passed to the LLM.
 */

// Exported for debugging/logging in agent-process-entry.ts
export const MULTIMODAL_MODEL_PATTERNS: RegExp[] = [
  /claude-3/i,
  /claude-3[.-]5/i,
  /claude-4/i,
  /claude-sonnet/i,
  /claude-opus/i,
  /claude-haiku/i,
  /gpt-4o/i,
  /gpt-4[.-]vision/i,
  /gpt-4[.-]turbo/i,
  /gpt-4v/i,
  /gpt-5/i,
  /o1/i,
  /o3/i,
  /o4/i,
  /gemini/i,
  /pixtral/i,
  /llava/i,
  /cogvlm/i,
  /qwen[.-]?vl/i,
  /qwen2[.-]?vl/i,
  /qwen2[.-]5[.-]?vl/i,
  /internvl/i,
  /minicpm[.-]?v/i,
  /yi[.-]?vision/i,
  /phi[.-]?3[.-]?vision/i,
  /phi[.-]?3[.-]5[.-]?vision/i,
  /phi[.-]?4[.-]?multimodal/i,
  /vision/i,
  /multimodal/i,
];

export const NON_MULTIMODAL_MODEL_PATTERNS: RegExp[] = [
  /gpt-3[.-]5/i,
  /gpt-4[^a-z-]/i,
  /claude-1/i,
  /claude-2/i,
  /claude-instant/i,
  /deepseek/i,
  /llama[^v]/i,
  /mistral/i,
  /mixtral/i,
  /codestral/i,
  /codellama/i,
  /starcoder/i,
  /wizard/i,
  /vicuna/i,
  /falcon/i,
  /orca/i,
  /zephyr/i,
  /solar/i,
];

// Legacy: internal constants kept for backward compat (can be removed later)
const MULTIMODAL_MODEL_PATTERNS_INTERNAL: RegExp[] = MULTIMODAL_MODEL_PATTERNS;
const NON_MULTIMODAL_MODEL_PATTERNS_INTERNAL: RegExp[] = NON_MULTIMODAL_MODEL_PATTERNS;

/**
 * Heuristic check: does the model name suggest multimodal (image input) support?
 *
 * Uses whitelist + blacklist patterns. Whitelist takes precedence —
 * if a model matches both lists, it's considered multimodal.
 *
 * This is NOT definitive. Providers may add/remove vision support without
 * changing the model name. When in doubt, the image blocks are still sent
 * and the provider will reject them with a clear error.
 */
export function isModelLikelyMultimodal(model: string): boolean {
  if (!model) return false;

  for (const pattern of MULTIMODAL_MODEL_PATTERNS) {
    if (pattern.test(model)) return true;
  }

  for (const pattern of NON_MULTIMODAL_MODEL_PATTERNS) {
    if (pattern.test(model)) return false;
  }

  return false;
}

/**
 * Known non-multimodal API error messages that indicate the model
 * doesn't support image content blocks.
 */
export function isMultimodalRejectionError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('does not support image') ||
    lower.includes('does not support vision') ||
    lower.includes('does not support multimodal') ||
    lower.includes('image input is not supported') ||
    lower.includes('image_url is not supported') ||
    lower.includes('images are not supported') ||
    lower.includes('multimodal is not supported') ||
    lower.includes('unrecognized request argument') ||
    lower.includes('invalid content type: image')
  );
}
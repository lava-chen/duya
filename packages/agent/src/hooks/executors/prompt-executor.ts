/**
 * Prompt Hook Executor
 *
 * Sends a prompt to an LLM and returns structured response.
 * Used for AI-driven decision hooks (e.g., "is this file modification safe?").
 */

import type { HookResult, PromptCommandHook } from '../types.js';

interface HookExecutorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PromptHookResponse {
  decision: 'approve' | 'block' | 'unknown';
  reason: string;
  data?: Record<string, unknown>;
}

const DEFAULT_PROMPT_TIMEOUT = 30 * 1000;

/**
 * Execute a prompt hook - sends a prompt to LLM and parses the JSON response
 */
export async function executePromptHook(
  hook: PromptCommandHook,
  jsonInput: string,
  options: HookExecutorOptions = {},
): Promise<Omit<HookResult, 'hook'>> {
  const timeoutMs = (hook.timeout ? hook.timeout * 1000 : 0) || options.timeoutMs || DEFAULT_PROMPT_TIMEOUT;
  const abortOptions: RequestInit = {};
  if (options.signal) {
    abortOptions.signal = options.signal;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal || controller.signal;

    const model = hook.model || process.env.DUYA_MODEL || 'claude-sonnet-4-20250514';
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';

    const response = await fetch(baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${hook.prompt}\n\n---\nHook Input:\n${jsonInput}\n\nRespond with a JSON object containing: { "decision": "approve" | "block" | "unknown", "reason": "...", "data": { ... } }`,
          },
        ],
      }),
      signal,
    } as RequestInit);

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        outcome: 'non_blocking_error',
        systemMessage: `Prompt hook LLM error: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as { content?: Array<{ text: string }> };
    const text = data.content?.[0]?.text || '';

    try {
      const parsed = JSON.parse(text) as PromptHookResponse;
      const result: Omit<HookResult, 'hook'> = {
        outcome: 'success',
        hookPermissionDecisionReason: parsed.reason,
      };

      if (parsed.decision === 'approve') {
        result.permissionBehavior = 'allow';
      } else if (parsed.decision === 'block') {
        result.permissionBehavior = 'deny';
        result.blockingError = {
          blockingError: parsed.reason || 'Blocked by prompt hook',
          command: hook.prompt,
        };
        result.outcome = 'blocking';
      }

      return result;
    } catch {
      return {
        outcome: 'non_blocking_error',
        systemMessage: 'Prompt hook returned non-JSON response',
      };
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { outcome: 'cancelled' };
    }
    return {
      outcome: 'non_blocking_error',
      systemMessage: `Prompt hook error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default executePromptHook;
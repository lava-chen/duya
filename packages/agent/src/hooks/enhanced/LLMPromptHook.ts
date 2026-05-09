/**
 * LLMPromptHook - LLM-driven prompt evaluation hook
 *
 * Uses an LLM to evaluate whether prompts or tool results indicate
 * success or failure, and whether to retry/skip/fallback.
 */

import type { HookContext, LLMEvaluationResult, LLMEvalHookConfig } from './types.js'

/**
 * Default evaluation prompt for tool execution results
 */
export const DEFAULT_EVALUATION_PROMPT = `You are evaluating whether the following tool execution result indicates success or failure.

Tool: {toolName}
Input: {toolInput}
Result: {toolResult}
Error: {error}

Analyze:
1. Did the tool execute successfully?
2. If failed, what is the likely cause?
3. Should we retry, skip, or use a different approach?

Respond with JSON: { "passed": bool, "action": "continue|modify|stop", "reasoning": "...", "confidence": 0.0-1.0 }`

/**
 * LLMPromptHook evaluates content using an LLM
 */
export class LLMPromptHook {
  private client: {
    apiKey: string
    model: string
    baseURL?: string
  }
  private evaluationPrompt: string
  private threshold: number

  constructor(options: LLMEvalHookConfig) {
    this.client = {
      apiKey: options.apiKey,
      model: options.model || '',
      baseURL: options.baseURL,
    }
    this.evaluationPrompt = options.evaluationPrompt || DEFAULT_EVALUATION_PROMPT
    this.threshold = options.threshold || 0.7
  }

  /**
   * Evaluate content with LLM
   */
  async evaluate(
    content: string,
    context: HookContext,
  ): Promise<LLMEvaluationResult> {
    try {
      const prompt = this.buildPrompt(content, context)

      const response = await this.callLLM(prompt)

      return this.parseResponse(response)
    } catch (error) {
      return {
        passed: false,
        action: 'continue',
        reasoning: `LLM evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        confidence: 0,
      }
    }
  }

  /**
   * Build evaluation prompt with context
   */
  private buildPrompt(content: string, context: HookContext): string {
    let prompt = this.evaluationPrompt

    if (context.toolUse) {
      prompt = prompt.replace('{toolName}', context.toolUse.name)
      prompt = prompt.replace('{toolInput}', JSON.stringify(context.toolUse.input))
    }

    prompt = prompt.replace('{toolResult}', content)
    prompt = prompt.replace('{error}', context.toolResult?.error || 'None')

    return prompt
  }

  /**
   * Call LLM API
   */
  private async callLLM(prompt: string): Promise<string> {
    // Use fetch to call LLM API
    const response = await fetch(this.client.baseURL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.client.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.client.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`)
    }

    const data = await response.json() as { content?: Array<{ text: string }> }
    return data.content?.[0]?.text || ''
  }

  /**
   * Parse LLM response
   */
  private parseResponse(response: string): LLMEvaluationResult {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(response)

      return {
        passed: Boolean(parsed.passed),
        action: parsed.action || 'continue',
        reasoning: parsed.reasoning,
        confidence: parsed.confidence ?? 0.5,
        modifiedContent: parsed.modifiedContent,
      }
    } catch {
      // If JSON parsing fails, assume continue
      return {
        passed: true,
        action: 'continue',
        reasoning: 'Could not parse LLM response, assuming continue',
        confidence: 0,
      }
    }
  }
}

/**
 * Create an LLM evaluation hook
 */
export function createLLMEvalHook(config: LLMEvalHookConfig): (context: HookContext) => Promise<{
  action: 'continue' | 'stop' | 'modify'
  modified?: boolean
  modifiedContent?: string
  metadata?: Record<string, unknown>
}> {
  const llmHook = new LLMPromptHook(config)

  return async (context: HookContext) => {
    const content = context.modifiedContent || context.prompt || JSON.stringify(context.messages || [])
    const result = await llmHook.evaluate(String(content), context)

    return {
      action: result.action || 'continue',
      modified: result.modifiedContent !== undefined,
      modifiedContent: result.modifiedContent,
      metadata: {
        confidence: result.confidence,
        reasoning: result.reasoning,
        passed: result.passed,
      },
    }
  }
}

export default LLMPromptHook
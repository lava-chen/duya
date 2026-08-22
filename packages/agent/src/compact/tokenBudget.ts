/**
 * Token Budget Management
 * Tracks and manages token usage across system prompt, context, and reserved space
 */

import type { TokenBudget, TokenBudgetConfig } from './types.js'
import { DEFAULT_BUDGET_CONFIG } from './types.js'

/**
 * TokenBudget implementation
 */
export class TokenBudgetManager implements TokenBudget {
  maxTokens: number
  systemPromptTokens: number
  contextTokens: number
  reservedTokens: number

  private _reserved: number = 0

  constructor(config: TokenBudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this.maxTokens = config.maxTokens
    this.systemPromptTokens = config.systemPromptTokens
    this.reservedTokens = config.reservedTokens
    this.contextTokens = 0
  }

  /**
   * Get available tokens for context
   */
  getAvailable(): number {
    return this.maxTokens - this.systemPromptTokens - this.reservedTokens - this._reserved - this.contextTokens
  }

  /**
   * Reserve tokens (e.g., for pending tool results)
   */
  reserve(tokens: number): void {
    this._reserved += tokens
  }

  /**
   * Release previously reserved tokens
   */
  release(tokens: number): void {
    this._reserved = Math.max(0, this._reserved - tokens)
  }

  /**
   * Check if budget is exhausted
   */
  isExhausted(): boolean {
    return this.getAvailable() <= 0
  }

  /**
   * Get utilization percentage
   */
  getUtilization(): number {
    const used = this.systemPromptTokens + this.reservedTokens + this._reserved + this.contextTokens
    return (used / this.maxTokens) * 100
  }

  /**
   * Update context token count
   */
  setContextTokens(tokens: number): void {
    this.contextTokens = tokens
  }

  /**
   * Reset reserved tokens
   */
  reset(): void {
    this._reserved = 0
    this.contextTokens = 0
  }
}

// ============================================================
// Token Estimation Utilities
// ============================================================

/**
 * Regex for CJK characters (Chinese, Japanese, Korean).
 * CJK characters typically consume ~1-2 tokens per character in BPE tokenizers,
 * while ASCII/English text averages ~4 characters per token.
 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

/** Token ratio for CJK characters (conservative: 2.5 chars/token) */
const CJK_CHARS_PER_TOKEN = 2.5
/** Token ratio for non-CJK characters */
const ASCII_CHARS_PER_TOKEN = 4

/**
 * Estimate tokens for a single message.
 * Uses language-aware estimation:
 * - CJK characters: ~2.5 chars/token (BPE tokenizers use more tokens for CJK)
 * - ASCII/English: ~4 chars/token
 */
/**
 * Extract the textual payload from a single content block.
 *
 * The old estimator did `JSON.stringify(message.content)` for any non-string
 * content, which inflates real prompt volume by 30-50% for tool-heavy
 * sessions — a 1MB tool result serialized back to JSON gains the structural
 * overhead of `{"type":"text","text":"..."}` wrappers, escape sequences,
 * key names, and bracket nesting. None of those count toward the LLM's
 * prompt-token budget (the API serializes its own wire format), but
 * `chars / 4` charges them all the same, producing 600%+ "context usage"
 * rings on 300+ message sessions whose real LLM-side prompt is well
 * under the window.
 *
 * Walk the Anthropic-style content block shape and return only the fields
 * the model actually pays tokens for: `text.text`, `thinking.thinking`,
 * `tool_use.input` (the argument blob), and the recursive `content` of a
 * `tool_result`. Image blocks are dropped — the provider counts them on
 * a separate visual-token budget, not the text budget.
 */
function contentBlockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as {
    type?: string;
    text?: string;
    thinking?: string;
    input?: unknown;
    content?: unknown;
  };
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? b.text : '';
    case 'thinking':
      return typeof b.thinking === 'string' ? b.thinking : '';
    case 'tool_use':
      // The model sees the input blob serialized; charge what it costs.
      return b.input !== undefined ? safeStringify(b.input) : '';
    case 'tool_result':
      if (typeof b.content === 'string') return b.content;
      if (Array.isArray(b.content)) {
        return (b.content as unknown[]).map(contentBlockText).join('');
      }
      return '';
    case 'image':
      // Image blocks get a separate visual-token budget from the provider;
      // don't inflate by counting the base64 source as text.
      return '';
    default:
      // Unknown block type: don't JSON.stringify the whole thing
      // (same overcount the old estimator did). Drop it from text count.
      return '';
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as unknown[]).map(contentBlockText).join('');
  }
  if (content === null || content === undefined) return '';
  // Last-resort: unknown shape (legacy persisted rows, custom providers).
  // Return empty rather than the full JSON blob — better to under-report
  // for an unknown shape than to over-report by 5x.
  return '';
}

/**
 * Estimate tokens for a single message.
 * Uses language-aware estimation:
 * - CJK characters: ~2.5 chars/token (BPE tokenizers use more tokens for CJK)
 * - ASCII/English: ~4 chars per token
 *
 * The text source is content-block-aware (see `extractMessageText`) so
 * tool_result arrays and tool_use inputs are charged at their real text
 * payload, not at their JSON serialization overhead.
 */
export function estimateMessageTokens(message: { role: string; content: string | unknown }): number {
  const content = extractMessageText(message.content)
  const cjkCount = (content.match(CJK_REGEX) || []).length
  const otherCount = content.length - cjkCount
  const cjkTokens = Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN)
  const otherTokens = Math.ceil(otherCount / ASCII_CHARS_PER_TOKEN)
  return cjkTokens + otherTokens
}

/**
 * Estimate tokens for an array of messages
 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string | unknown }>): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

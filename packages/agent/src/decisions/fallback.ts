/**
 * decisions/fallback.ts — LLM structured-output decision fallback
 * (plan 551 Phase 2).
 *
 * Second link in the degradation chain Jev → LLM structured-output →
 * caller rules. Mirrors the official system-one-adapter pattern: wrap
 * a chat LLM so it satisfies the same `DecisionClient` interface — the
 * prompt pins JSON output and the response is parsed into typed
 * answers. Degradation events are logged so operators can see how
 * often the expensive path fires.
 */

import type {
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
  DecisionAnswer,
} from '@duya/ai';
import { DecisionProtocolError } from '@duya/ai';
import { logger } from '../utils/logger.js';
import { DECISIONS_LOG_COMPONENT } from './calibration.js';

/** Minimal chat surface the fallback needs (satisfied by AIClient.chat). */
export interface LlmChatClient {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { systemPrompt?: string; maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<{ content: string }>;
}

export interface LlmDecisionFallbackOptions {
  llm: LlmChatClient;
  /** Per-request wall budget. Default 10_000ms (LLMs are slower than Jev). */
  timeoutMs?: number;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1] : trimmed;
}

/**
 * Parse the LLM's JSON answer into a DecisionResponse. Lenient about
 * fences; strict about shape — a garbage answer throws (the caller
 * then falls to rules), never silently maps to a wrong decision.
 */
export function parseLlmDecision(request: DecisionRequest, text: string): DecisionResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new DecisionProtocolError('llm fallback did not return parseable JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DecisionProtocolError('llm fallback JSON is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const raw = obj[id];
    if (raw === undefined) {
      throw new DecisionProtocolError(`llm fallback answer missing for "${id}"`);
    }
    if (q.kind === 'noul') {
      const p = typeof raw === 'number' ? raw : (raw as { p?: unknown })?.p;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
        throw new DecisionProtocolError(`llm fallback noul "${id}" is not a probability`);
      }
      answers[id] = { kind: 'noul', p };
    } else if (q.kind === 'choice') {
      const value = typeof raw === 'string' ? raw : (raw as { value?: unknown })?.value;
      if (typeof value !== 'string' || !q.options.includes(value)) {
        throw new DecisionProtocolError(`llm fallback choice "${id}" is not one of the options`);
      }
      answers[id] = { kind: 'choice', value, distribution: { [value]: 1 } };
    } else {
      const value = typeof raw === 'number' ? raw : (raw as { value?: unknown })?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DecisionProtocolError(`llm fallback score "${id}" is not numeric`);
      }
      answers[id] = { kind: 'score', value, distribution: {} };
    }
  }
  return { answers };
}

/**
 * DecisionClient implemented over a chat LLM. One chat call per decide
 * request with all questions inlined as a JSON schema prompt.
 */
export class LlmDecisionFallback implements DecisionClient {
  private readonly llm: LlmChatClient;
  private readonly timeoutMs: number;

  constructor(options: LlmDecisionFallbackOptions) {
    this.llm = options.llm;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const schema: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.kind === 'noul') schema[id] = { type: 'noul', p: 'number in [0,1]' };
      else if (q.kind === 'choice') schema[id] = { type: 'choice', value: `one of: ${q.options.join(' | ')}` };
      else schema[id] = { type: 'score', value: `number; levels low→high: ${q.levels.join(' | ')}` };
    }

    const messages = [
      {
        role: 'user',
        content:
          `State (JSON):\n${JSON.stringify(request.state, null, 2)}\n\n` +
          `Answer every question. Respond with ONLY a JSON object keyed by question id:\n${JSON.stringify(schema, null, 2)}`,
      },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let content: string;
    try {
      const res = await this.llm.chat(messages, {
        systemPrompt:
          'You are a decision function. You never generate free text — you return only the JSON object described by the user, assigning calibrated probabilities.',
        maxTokens: 512,
        temperature: 0,
        signal: controller.signal,
      });
      content = res.content;
    } finally {
      clearTimeout(timer);
    }

    logger.debug('decisions: fallback llm decide fired', { questions: Object.keys(request.questions).length }, DECISIONS_LOG_COMPONENT);
    return parseLlmDecision(request, content);
  }
}

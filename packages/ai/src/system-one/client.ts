/**
 * system-one/client.ts — SystemOneClient (plan 551 Phase 1).
 *
 * Thin HTTP client for the Jev / System One decide API. One request =
 * state + many questions; the server evaluates all questions in parallel
 * (adding questions costs tokens, not latency). This module deliberately
 * lives OUTSIDE the `providers/` chat abstraction: decision shape ≠ chat
 * shape (plan 551 Non-Goals — no streaming, no prompt templates).
 *
 * Wire contract (docs.typesafe.ai /api, see docs/references/jev-model-research.md §3.2):
 *   POST {baseUrl}/decide
 *   { "model": "jev-latest", "state": <state>, "questions": { id: {...} } }
 *   → { id: { "type": "noul", "noul": 0.999 } | { "type": "choice", ... } ... }
 *
 * Reliability: timeoutMs budget (default 2000ms; Jev P99 ~500ms) via
 * AbortController + one retry on transient failures, aligned with the
 * package's retry style (utils/retry.ts).
 */

import type {
  DecisionRequest,
  DecisionResponse,
  DecisionAnswer,
  Question,
} from './types.js';
import {
  DecisionProtocolError,
  validateDecisionRequest,
} from './types.js';
import { retryOperation } from '../utils/retry.js';

export interface SystemOneClientOptions {
  /** Typesafe API key (TYPESAFE_API_KEY or credential store). */
  apiKey: string;
  /** Model id. Default `jev-latest`. */
  model?: string;
  /** API origin. Default the public Typesafe endpoint. */
  baseUrl?: string;
  /** Whole-request budget in ms. Default 2000. */
  timeoutMs?: number;
  /** Retries on transient network/5xx/429. Default 1. */
  maxRetries?: number;
  /** Injectable transport (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export const DEFAULT_SYSTEM_ONE_BASE_URL = 'https://api.typesafe.ai/v1';
export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';
export const DEFAULT_SYSTEM_ONE_TIMEOUT_MS = 2000;

/**
 * The thin abstraction every decision backend satisfies. Jev is the first
 * implementation; LLM structured-output (system-one-adapter pattern) and
 * local SemIf-style backends are future implementations. Consumers depend
 * on THIS interface, never on SystemOneClient directly (plan 551: 原语先行、后端可换).
 */
export interface DecisionClient {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/** Serialize a Question into the wire shape. */
function questionToWire(q: Question): Record<string, unknown> {
  switch (q.kind) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, options: [...q.options] };
    case 'score':
      return { type: 'score', instructions: q.instructions, levels: [...q.levels] };
    case 'noul':
      return { type: 'noul', instructions: q.instructions };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse + validate one wire answer. Throws DecisionProtocolError on garbage. */
function parseAnswer(id: string, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) {
    throw new DecisionProtocolError(`answer "${id}" is not an object`);
  }
  const type = raw.type;
  if (type === 'noul') {
    const p = raw.noul;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new DecisionProtocolError(`noul answer "${id}" carries no valid probability`);
    }
    return { kind: 'noul', p };
  }
  if (type === 'choice') {
    const value = raw.choice ?? raw.value ?? raw.option;
    if (typeof value !== 'string' || value.length === 0) {
      throw new DecisionProtocolError(`choice answer "${id}" carries no option value`);
    }
    const distribution: Record<string, number> = {};
    const rawDist = raw.distribution ?? raw.probabilities;
    if (isRecord(rawDist)) {
      for (const [opt, p] of Object.entries(rawDist)) {
        if (typeof p === 'number' && Number.isFinite(p)) distribution[opt] = p;
      }
    }
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? raw.confidence
        : undefined;
    return { kind: 'choice', value, distribution, confidence };
  }
  if (type === 'score') {
    const value = raw.score ?? raw.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DecisionProtocolError(`score answer "${id}" carries no numeric value`);
    }
    const distribution: Record<string, number> = {};
    const rawDist = raw.distribution ?? raw.probabilities;
    if (isRecord(rawDist)) {
      for (const [level, p] of Object.entries(rawDist)) {
        if (typeof p === 'number' && Number.isFinite(p)) distribution[level] = p;
      }
    }
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? raw.confidence
        : undefined;
    return { kind: 'score', value, distribution, confidence };
  }
  throw new DecisionProtocolError(`answer "${id}" has unknown type "${String(type)}"`);
}

/** Parse the full wire response; every requested question must be answered. */
export function parseDecisionResponse(
  request: DecisionRequest,
  body: unknown,
): DecisionResponse {
  if (!isRecord(body)) {
    throw new DecisionProtocolError('decide response is not an object');
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const id of Object.keys(request.questions)) {
    const raw = body[id];
    if (raw === undefined) {
      throw new DecisionProtocolError(`response is missing answer for question "${id}"`);
    }
    answers[id] = parseAnswer(id, raw);
  }
  return { answers };
}

/** One decide round-trip: validate → POST → parse. */
export class SystemOneClient implements DecisionClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: SystemOneClientOptions) {
    if (!options.apiKey) {
      throw new Error('SystemOneClient requires an API key');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_SYSTEM_ONE_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_SYSTEM_ONE_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SYSTEM_ONE_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 1;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    validateDecisionRequest(request);

    const wireQuestions: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      wireQuestions[id] = questionToWire(q);
    }
    const body = JSON.stringify({
      model: this.model,
      state: request.state,
      questions: wireQuestions,
    });

    // retryOperation classifies via LLMAPIError: errors carrying `status`
    // 429/5xx are retryable, other 4xx are not, abort (our timeout) is
    // rethrown. Attach `status` so that machinery works unchanged.
    const result = await retryOperation(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await this.fetchFn(`${this.baseUrl}/decide`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
            },
            body,
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err: Error & { status?: number } = new Error(
              `system-one decide failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
            );
            err.status = res.status;
            throw err;
          }
          return (await res.json()) as unknown;
        } finally {
          clearTimeout(timer);
        }
      },
      { maxRetries: this.maxRetries },
    ).then((r) => {
      if (!r.success) throw r.error ?? new Error('system-one decide failed');
      return r.data;
    });

    return parseDecisionResponse(request, result);
  }
}

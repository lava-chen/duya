import { describe, it, expect } from 'vitest';
import {
  APIErrorType,
  classifyError,
  isRetryableError,
  createLLMAPIError,
  extractProviderErrorMessage,
} from '../src/utils/errors.js';

describe('classifyError', () => {
  it('classifies 429 as rate limit', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    expect(classifyError(err)).toBe(APIErrorType.RATE_LIMIT);
    expect(isRetryableError(err)).toBe(true);
  });
  it('classifies quota as non-retryable usage limit', () => {
    const err = new Error('insufficient_quota');
    expect(classifyError(err)).toBe(APIErrorType.USAGE_LIMIT);
    expect(isRetryableError(err)).toBe(false);
  });
  it('wraps into LLMAPIError', () => {
    const llmErr = createLLMAPIError(new Error('boom'));
    expect(llmErr.name).toBe('LLMAPIError');
    expect(llmErr.isRetryable).toBe(false);
  });

  // Plan 462: billing shortfall reuses 429 but must NOT be retried — the
  // balance only recovers when the user tops up.
  describe('insufficient balance (Plan 462)', () => {
    const cases: Array<[string, unknown]> = [
      [
        'zhipu GLM JSON-wrapped 429',
        Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113][余额不足或无可用资源包,请充值。][20260830103053d5cdf3ab34bf42fc]"}}'), { status: 429 }),
      ],
      ['plain Chinese message', new Error('账户余额不足，请充值')],
      ['english message', new Error('insufficient balance, please recharge')],
      ['resource pack wording', new Error('no available resource pack')],
    ];

    for (const [name, err] of cases) {
      it(`classifies ${name} as non-retryable INSUFFICIENT_BALANCE`, () => {
        expect(classifyError(err)).toBe(APIErrorType.INSUFFICIENT_BALANCE);
        expect(isRetryableError(err)).toBe(false);
      });
    }

    it('extracts the provider wording from a status-prefixed JSON body', () => {
      const err = new Error('429 {"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113][余额不足或无可用资源包,请充值。][20260830103053d5cdf3ab34bf42fc]"}}');
      // Provider wording kept verbatim (half-width comma included) — only the
      // [code] / [requestId] bracket noise is removed.
      expect(extractProviderErrorMessage(err)).toBe('余额不足或无可用资源包,请充值。');
    });

    it('returns undefined when the message has nothing to extract', () => {
      expect(extractProviderErrorMessage(new Error('rate limited'))).toBeUndefined();
    });
  });

  // Plan 439: status-less transport-level stream deaths must be retryable.
  describe('transport stream-death patterns', () => {
    const cases: Array<[string, Error]> = [
      ['undici premature body close', new TypeError('terminated')],
      ['node fetch socket failure', new TypeError('fetch failed')],
      ['undici premature close text', new Error('premature close')],
      ['peer reset mid-stream', new Error('other side closed')],
      ['proxy socket death', new Error('socket hang up')],
      ['aggregator drop', new Error('connection lost')],
      ['generic network failure', new TypeError('network error')],
      // OpenRouter upstream-failure wrappers (no HTTP status reaches us).
      ['openrouter upstream error', new Error('Provider returned error')],
      [
        'openrouter buffer overflow',
        new Error('exceeded request buffer limit while retrying upstream'),
      ],
      // duya's own premature-end guard message (openai-completions.ts).
      ['finish_reason guard', new Error('OpenAI-compatible stream ended without finish_reason')],
    ];

    for (const [name, err] of cases) {
      it(`classifies ${name} as a retryable connection error`, () => {
        expect(classifyError(err)).toBe(APIErrorType.CONNECTION_ERROR);
        expect(isRetryableError(err)).toBe(true);
      });
    }

    it('keeps quota semantics when the message also matches a transport pattern', () => {
      const err = new Error('insufficient_quota: request terminated early');
      expect(classifyError(err)).toBe(APIErrorType.USAGE_LIMIT);
      expect(isRetryableError(err)).toBe(false);
    });

    it('keeps HTTP-status semantics over transport patterns', () => {
      // A 400 whose message happens to contain a fragment stays CLIENT_ERROR
      // (deterministic), and a 502 keeps its SERVER_ERROR classification.
      const badRequest = Object.assign(new Error('request terminated'), { status: 400 });
      expect(classifyError(badRequest)).toBe(APIErrorType.CLIENT_ERROR);
      expect(isRetryableError(badRequest)).toBe(false);

      const badGateway = Object.assign(new Error('terminated'), { status: 502 });
      expect(classifyError(badGateway)).toBe(APIErrorType.SERVER_ERROR);
      expect(isRetryableError(badGateway)).toBe(true);
    });

    it('does not classify aborts via transport patterns', () => {
      const err = new Error('fetch failed: aborted');
      (err as { name: string }).name = 'AbortError';
      expect(classifyError(err)).toBe(APIErrorType.ABORTED);
      expect(isRetryableError(err)).toBe(false);
    });
  });
});
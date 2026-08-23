import { describe, it, expect } from 'vitest';
import { APIErrorType, classifyError, isRetryableError, createLLMAPIError } from '../src/utils/errors.js';

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
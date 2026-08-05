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
});
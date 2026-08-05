import { describe, it, expect } from 'vitest';
import { withRetry, retryOperation } from '../src/utils/retry.js';
import { LLMAPIError, APIErrorType } from '../src/utils/errors.js';

describe('withRetry', () => {
  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const gen = withRetry(async function* () {
      calls++;
      if (calls < 3) throw new LLMAPIError({ message: 'overloaded', type: APIErrorType.SERVER_OVERLOAD, isRetryable: true });
      yield { type: 'text', data: 'ok' };
    }, { maxRetries: 5, backoffOptions: { baseDelayMs: 1, maxDelayMs: 2, multiplier: 2, jitterFactor: 0 } });
    const events: string[] = [];
    for await (const e of gen) events.push((e as { type: string }).type);
    expect(events).toContain('text');
    expect(calls).toBe(3);
  });
});

describe('retryOperation', () => {
  it('returns success result', async () => {
    const res = await retryOperation(async () => 'value', { maxRetries: 2 });
    expect(res.success).toBe(true);
    expect(res.data).toBe('value');
  });
});
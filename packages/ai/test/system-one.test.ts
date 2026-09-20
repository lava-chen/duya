/**
 * system-one.test.ts — plan 551 Phase 1 gate.
 *
 * Full contract coverage against a fake transport (no network):
 * parallel question mapping, partial failure, timeout, illegal
 * responses, cardinality enforcement, retry on transient failures,
 * and config resolution.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SystemOneClient,
  resolveSystemOneConfig,
  validateDecisionRequest,
  DecisionProtocolError,
  DEFAULT_SYSTEM_ONE_CONFIG,
  type DecisionRequest,
} from '../src/system-one/index.js';

type FetchCall = { url: string; init: RequestInit };

function makeTransport(
  responder: (body: unknown) => { status: number; json?: unknown },
): { calls: FetchCall[]; fetchFn: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = JSON.parse(String(init?.body ?? '{}'));
    const res = responder(body);
    return new Response(res.json === undefined ? 'oops' : JSON.stringify(res.json), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const THREE_QUESTIONS: DecisionRequest = {
  state: { page: 'login', fields: ['email', 'password'] },
  questions: {
    target: {
      kind: 'choice',
      instructions: 'Which element should be clicked next?',
      options: ['#1 email field', '#2 password field', '#3 submit button'],
    },
    done: { kind: 'noul', instructions: 'Is the login fully completed?' },
    quality: { kind: 'score', instructions: 'How filled is the form?', levels: ['empty', 'partial', 'full'] },
  },
};

const OK_RESPONSE = {
  target: { type: 'choice', choice: '#3 submit button', distribution: { '#1 email field': 0.05, '#2 password field': 0.05, '#3 submit button': 0.9 }, confidence: 0.94 },
  done: { type: 'noul', noul: 0.12 },
  quality: { type: 'score', score: 1.4, distribution: { empty: 0.4, partial: 0.5, full: 0.1 }, confidence: 0.7 },
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  delete process.env.TYPESAFE_MODEL;
  delete process.env.TYPESAFE_TIMEOUT_MS;
});

describe('SystemOneClient', () => {
  it('sends one request with all questions and maps answers back by id', async () => {
    const { calls, fetchFn } = makeTransport(() => ({ status: 200, json: OK_RESPONSE }));
    const client = new SystemOneClient({ apiKey: 'k', fetchFn });

    const res = await client.decide(THREE_QUESTIONS);

    // One round-trip, all three questions inside it.
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions).sort()).toEqual(['done', 'quality', 'target']);
    expect(body.questions.target.options).toHaveLength(3);
    expect(body.state).toEqual(THREE_QUESTIONS.state);

    // Typed answers.
    expect(res.answers.target).toEqual({
      kind: 'choice',
      value: '#3 submit button',
      distribution: expect.objectContaining({ '#3 submit button': 0.9 }),
      confidence: 0.94,
    });
    expect(res.answers.done).toEqual({ kind: 'noul', p: 0.12 });
    expect(res.answers.quality).toEqual({
      kind: 'score',
      value: 1.4,
      distribution: expect.objectContaining({ partial: 0.5 }),
      confidence: 0.7,
    });
  });

  it('serializes question kinds into the wire shape', async () => {
    const { calls, fetchFn } = makeTransport(() => ({ status: 200, json: OK_RESPONSE }));
    const client = new SystemOneClient({ apiKey: 'k', fetchFn });
    await client.decide(THREE_QUESTIONS);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.questions.target).toMatchObject({ type: 'choice', options: ['#1 email field', '#2 password field', '#3 submit button'] });
    expect(body.questions.done).toMatchObject({ type: 'noul' });
    expect(body.questions.quality).toMatchObject({ type: 'score', levels: ['empty', 'partial', 'full'] });
  });

  it('rejects when a question is missing from the response (partial failure)', async () => {
    const partial = { ...OK_RESPONSE };
    delete (partial as Record<string, unknown>).done;
    const { fetchFn } = makeTransport(() => ({ status: 200, json: partial }));
    const client = new SystemOneClient({ apiKey: 'k', fetchFn });

    await expect(client.decide(THREE_QUESTIONS)).rejects.toThrow(DecisionProtocolError);
    await expect(client.decide(THREE_QUESTIONS)).rejects.toThrow(/"done"/);
  });

  it('rejects illegal answers (bad noul probability, unknown type)', async () => {
    const badNoul = { ...OK_RESPONSE, done: { type: 'noul', noul: 7 } };
    const { fetchFn } = makeTransport(() => ({ status: 200, json: badNoul }));
    const client = new SystemOneClient({ apiKey: 'k', fetchFn });
    await expect(client.decide(THREE_QUESTIONS)).rejects.toThrow(/valid probability/);

    const badType = { ...OK_RESPONSE, target: { type: 'poem' } };
    const { fetchFn: fetchFn2 } = makeTransport(() => ({ status: 200, json: badType }));
    const client2 = new SystemOneClient({ apiKey: 'k', fetchFn: fetchFn2 });
    await expect(client2.decide(THREE_QUESTIONS)).rejects.toThrow(/unknown type/);
  });

  it('enforces the 255 cardinality cap before any network call', async () => {
    const { calls, fetchFn } = makeTransport(() => ({ status: 200, json: OK_RESPONSE }));
    const client = new SystemOneClient({ apiKey: 'k', fetchFn });

    const manyQuestions: DecisionRequest = {
      state: {},
      questions: Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => [`q${i}`, { kind: 'noul' as const, instructions: 'x' }]),
      ),
    };
    await expect(client.decide(manyQuestions)).rejects.toThrow(/too many questions/);
    expect(calls).toHaveLength(0);

    const tooManyOptions: DecisionRequest = {
      state: {},
      questions: {
        t: { kind: 'choice', instructions: 'x', options: Array.from({ length: 256 }, (_, i) => `o${i}`) },
      },
    };
    await expect(client.decide(tooManyOptions)).rejects.toThrow(/cap 255/);
    expect(calls).toHaveLength(0);
  });

  it('times out per the timeoutMs budget', async () => {
    // Transport that ignores the result but honors abort, like real fetch.
    const slowFetch = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const client = new SystemOneClient({ apiKey: 'k', timeoutMs: 50, maxRetries: 0, fetchFn: slowFetch });
    await expect(client.decide(THREE_QUESTIONS)).rejects.toThrow();
  }, 5000);

  it('retries transient 5xx then succeeds; does not retry 4xx', async () => {
    let attempts = 0;
    const { calls, fetchFn } = makeTransport(() => {
      attempts++;
      return attempts === 1 ? { status: 503 } : { status: 200, json: OK_RESPONSE };
    });
    const client = new SystemOneClient({ apiKey: 'k', fetchFn, maxRetries: 1 });
    const res = await client.decide(THREE_QUESTIONS);
    expect(calls).toHaveLength(2);
    expect(res.answers.done).toEqual({ kind: 'noul', p: 0.12 });

    const { calls: calls2, fetchFn: fetchFn2 } = makeTransport(() => ({ status: 401 }));
    const client2 = new SystemOneClient({ apiKey: 'k', fetchFn: fetchFn2, maxRetries: 3 });
    await expect(client2.decide(THREE_QUESTIONS)).rejects.toThrow(/HTTP 401/);
    expect(calls2).toHaveLength(1);
  });

  it('throws when constructed without an API key', () => {
    expect(() => new SystemOneClient({ apiKey: '', fetchFn: fetch })).toThrow(/API key/);
  });
});

describe('validateDecisionRequest', () => {
  it('rejects empty questions and choice questions with <2 options', () => {
    expect(() => validateDecisionRequest({ state: {}, questions: {} })).toThrow(/no questions/);
    expect(() =>
      validateDecisionRequest({
        state: {},
        questions: { c: { kind: 'choice', instructions: 'x', options: ['only'] } },
      }),
    ).toThrow(/at least 2 options/);
    expect(() =>
      validateDecisionRequest({ state: {}, questions: { n: { kind: 'noul', instructions: '' } } }),
    ).toThrow(/instructions/);
  });
});

describe('resolveSystemOneConfig', () => {
  it('defaults to disabled with jev-latest', () => {
    const cfg = resolveSystemOneConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toBe(DEFAULT_SYSTEM_ONE_CONFIG.model);
    expect(cfg.timeoutMs).toBeGreaterThan(0);
  });

  it('explicit enabled without a key collapses back to disabled (zero-difference guarantee)', () => {
    expect(resolveSystemOneConfig({ enabled: true }).enabled).toBe(false);
    expect(resolveSystemOneConfig({ enabled: true, apiKey: 'k' }).enabled).toBe(true);
  });

  it('env fills missing values but explicit enabled=false wins', () => {
    process.env.TYPESAFE_API_KEY = 'env-key';
    process.env.TYPESAFE_BASE_URL = 'https://mirror.example.com/v2';
    process.env.TYPESAFE_TIMEOUT_MS = '1200';
    const cfg = resolveSystemOneConfig({ enabled: true });
    expect(cfg.apiKey).toBe('env-key');
    expect(cfg.baseUrl).toBe('https://mirror.example.com/v2');
    expect(cfg.timeoutMs).toBe(1200);
    // Explicit off wins over env key.
    process.env.TYPESAFE_API_KEY = 'env-key';
    expect(resolveSystemOneConfig({ enabled: false, apiKey: 'x' }).enabled).toBe(false);
  });
});

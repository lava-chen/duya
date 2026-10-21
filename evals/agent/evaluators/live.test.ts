/**
 * Plan 587 E4.3 — the live (stochastic) path.
 *
 * Everything here is exercised against a SYNTHETIC series, and the report says
 * so (`source: 'synthetic-fixture'`). That is the point of the test as much as
 * the subject: a test in this repo must never be mistakable for a live-model
 * result, and a live observation that did not come from a provider has to say
 * which it is.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNotPerTokenDeterministic,
  FORBIDDEN_LIVE_CLAIM,
  liveReadiness,
  makeLiveObservation,
  summarise,
  type LiveParameters,
} from './live';

const PARAMS: LiveParameters = { model: 'm', temperature: 0, maxTokens: 512, measurements: 5 };

describe('E4.3 — live sample statistics', () => {
  it('summarises a sample with its min, max, mean, variance and spread', () => {
    const s = summarise([10, 20, 30, 40, 50]);
    expect(s.n).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
    expect(s.mean).toBe(30);
    // Sample variance of 10..50 is 250 (n-1 denominator).
    expect(s.variance).toBe(250);
    expect(s.spread).toBe(40);
  });

  it('refuses to summarise a single measurement, because a variance from one sample is a claim', () => {
    expect(() => summarise([42])).toThrow(/at least two measurements/);
  });

  it('reports zero spread when the sample really is constant, without claiming determinism', () => {
    const s = summarise([7, 7, 7]);
    expect(s.spread).toBe(0);
    expect(s.variance).toBe(0);
  });
});

describe('E4.3 — a live observation never claims per-token determinism', () => {
  it('labels itself not-claimed and names its source', () => {
    const obs = makeLiveObservation({
      parameters: PARAMS,
      source: 'synthetic-fixture',
      method: 'unit test series',
      series: { outputTokens: [100, 104, 98, 101, 103] },
    });
    expect(obs.determinism).toBe('not-claimed');
    expect(obs.source).toBe('synthetic-fixture');
    expect(obs.metrics.outputTokens?.n).toBe(5);
  });

  it('rejects an observation that carries the forbidden determinism claim', () => {
    const obs = {
      determinism: 'not-claimed' as const,
      parameters: PARAMS,
      metrics: {},
      source: 'synthetic-fixture' as const,
      method: 'x',
    };
    expect(() =>
      assertNotPerTokenDeterministic({ ...obs, method: `${obs.method} ${FORBIDDEN_LIVE_CLAIM}` }),
    ).toThrow(/must not claim/);
  });

  it('rejects an observation that relabels itself as deterministic', () => {
    const obs = makeLiveObservation({
      parameters: { ...PARAMS, measurements: 2 },
      source: 'synthetic-fixture', method: 'x', series: { t: [1, 2] },
    });
    expect(() => assertNotPerTokenDeterministic({ ...obs, determinism: 'per-token-deterministic' as never })).toThrow(/must be labelled/);
  });

  it('rejects a live case that asks for fewer than two measurements', () => {
    expect(() =>
      makeLiveObservation({
        parameters: { ...PARAMS, measurements: 1 },
        source: 'synthetic-fixture', method: 'x', series: { t: [1] },
      }),
    ).toThrow(/at least 2 measurements/);
  });

  it('rejects a series whose length disagrees with the declared measurement count', () => {
    expect(() =>
      makeLiveObservation({
        parameters: PARAMS, source: 'synthetic-fixture', method: 'x', series: { t: [1, 2, 3] },
      }),
    ).toThrow(/the case declares 5 measurements/);
  });
});

describe('E4.3 — live readiness names the missing capability', () => {
  it('is NOT ready without a credential, and says which credential', () => {
    const readiness = liveReadiness({} as NodeJS.ProcessEnv);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockedBy).toMatch(/live-provider-credentials/);
  });

  it('is NOT ready with a credential but no network authorisation', () => {
    const readiness = liveReadiness({ DUYA_EVAL_LIVE_KEY: 'sk-x' } as NodeJS.ProcessEnv);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockedBy).toMatch(/DUYA_EVAL_ALLOW_NETWORK/);
  });

  it('is ready only with both a credential and explicit network authorisation', () => {
    const readiness = liveReadiness({
      DUYA_EVAL_LIVE_KEY: 'sk-x', DUYA_EVAL_ALLOW_NETWORK: '1',
    } as NodeJS.ProcessEnv);
    expect(readiness.ready).toBe(true);
  });

  it('always names what a live run still would not prove, even when ready', () => {
    const readiness = liveReadiness({ DUYA_EVAL_LIVE_KEY: 'sk-x', DUYA_EVAL_ALLOW_NETWORK: '1' } as NodeJS.ProcessEnv);
    expect(readiness.unsupported.length).toBeGreaterThan(0);
    expect(readiness.unsupported.join(' ')).toMatch(/per-token determinism/);
  });
});

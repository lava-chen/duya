/**
 * decisions.test.ts — plan 551 Phase 2 gate.
 *
 * Covers the DecisionService contract: chain ordering (Jev → LLM →
 * throw), policy gray band, calibration records, template shapes, the
 * 419 pre-screen suggestion channel, and the zero-difference guarantee
 * when no key is configured.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DecisionClient, DecisionRequest, DecisionResponse } from '@duya/ai';
import {
  DecisionService,
  DecisionUnavailableError,
  createPermissionPrescreener,
  createDecisionServiceFromConfig,
  resetDecisionService,
  getDecisionService,
  LlmDecisionFallback,
  DEFAULT_DECISION_POLICY,
  evaluateNoul,
  topCandidates,
  type CalibrationRecord,
  type CalibrationSink,
} from '../index.js';
import { CalibrationLogger } from '../calibration.js';
import { parseLlmDecision } from '../fallback.js';

function fakeClient(responder: (req: DecisionRequest) => Promise<DecisionResponse>): DecisionClient {
  return { decide: vi.fn(responder) };
}

function noulRes(entries: Record<string, number>): DecisionResponse {
  const answers: DecisionResponse['answers'] = {};
  for (const [id, p] of Object.entries(entries)) answers[id] = { kind: 'noul', p };
  return { answers };
}

function memorySink(): { sink: CalibrationSink; records: CalibrationRecord[] } {
  const records: CalibrationRecord[] = [];
  return { sink: { append: (r) => records.push(r) }, records };
}

describe('DecisionService chain', () => {
  it('no client configured → available=false and ask throws DecisionUnavailableError (zero-difference path)', async () => {
    const service = new DecisionService({});
    expect(service.available).toBe(false);
    await expect(service.ask({}, { done: { kind: 'noul', instructions: 'x' } })).rejects.toThrow(
      DecisionUnavailableError,
    );
  });

  it('primary client answers; every noul is calibrated', async () => {
    const { sink, records } = memorySink();
    const primary = fakeClient(async () => noulRes({ done: 0.93, error: 0.05 }));
    const service = new DecisionService({
      client: primary,
      calibration: new CalibrationLogger(sink),
    });

    const res = await service.ask(
      { screen: '...' },
      { done: { kind: 'noul', instructions: 'done?' }, error: { kind: 'noul', instructions: 'err?' } },
    );

    expect(res.answers.done).toEqual({ kind: 'noul', p: 0.93 });
    expect(records.map((r) => [r.question, r.probability])).toEqual([
      ['done', 0.93],
      ['error', 0.05],
    ]);
    expect(records[0].kind).toBe('noul');
  });

  it('falls back to the LLM client when the primary throws', async () => {
    const primary = fakeClient(async () => {
      throw new Error('jev down');
    });
    const fallback = fakeClient(async () => noulRes({ done: 0.2 }));
    const service = new DecisionService({ client: primary, fallback });

    const res = await service.ask({}, { done: { kind: 'noul', instructions: 'done?' } });
    expect(res.answers.done).toEqual({ kind: 'noul', p: 0.2 });
  });

  it('throws DecisionUnavailableError when the whole chain fails', async () => {
    const boom = fakeClient(async () => {
      throw new Error('nope');
    });
    const service = new DecisionService({ client: boom, fallback: boom });
    await expect(service.ask({}, { done: { kind: 'noul', instructions: 'x' } })).rejects.toThrow(
      DecisionUnavailableError,
    );
  });

  it('resolveNoul maps the gray band to uncertain, not a guess', async () => {
    const service = new DecisionService({ client: fakeClient(async () => noulRes({ d: 0.55 })) });
    const res = await service.ask({}, { d: { kind: 'noul', instructions: 'x' } });
    const resolved = service.resolveNoul(res, 'd');
    expect(resolved.p).toBe(0.55);
    expect(resolved.verdict).toBe('uncertain');
    expect(evaluateNoul(0.9)).toBe('yes');
    expect(evaluateNoul(0.1)).toBe('no');
  });
});

describe('DecisionService templates', () => {
  it('exposes the route/risk/verify/done shapes with the right kinds', () => {
    const service = new DecisionService({});
    expect(service.doneQuestion('Log in')).toMatchObject({ kind: 'noul' });
    expect(service.errorQuestion('Log in').kind).toBe('noul');
    expect(service.blockedQuestion('Log in').kind).toBe('noul');
    expect(service.irreversibleQuestion('click Buy').kind).toBe('noul');
    expect(service.verifyQuestion('dialog closed').kind).toBe('noul');
    const route = service.routeQuestion('pick', ['a', 'b', 'c']);
    expect(route).toMatchObject({ kind: 'choice', options: ['a', 'b', 'c'] });
  });

  it('candidates returns the top-k distribution for ambiguous escalation', () => {
    const service = new DecisionService({
      client: fakeClient(async () => ({
        answers: {
          t: {
            kind: 'choice',
            value: 'b',
            distribution: { b: 0.4, c: 0.35, a: 0.25 },
            confidence: 0.4,
          },
        },
      })),
    });
    void service;
    const response = {
      answers: {
        t: { kind: 'choice', value: 'b', distribution: { b: 0.4, c: 0.35, a: 0.25 }, confidence: 0.4 },
      },
    };
    expect(service.candidates(response, 't', 2)).toEqual([
      { option: 'b', p: 0.4 },
      { option: 'c', p: 0.35 },
    ]);
    expect(topCandidates({}, 3)).toEqual([]);
    expect(DEFAULT_DECISION_POLICY.doneAt).toBeGreaterThan(DEFAULT_DECISION_POLICY.rejectAt);
  });
});

describe('createPermissionPrescreener (419 infra channel)', () => {
  it('suggests gate on high risk noul and null on unavailable service', async () => {
    const risky = new DecisionService({ client: fakeClient(async () => noulRes({ risk: 0.91 })) });
    const prescreen = createPermissionPrescreener(risky, true);
    await expect(prescreen('bash', { command: 'rm -rf /tmp/x' })).resolves.toEqual({
      suggestion: 'gate',
      p: 0.91,
    });

    const disabled = createPermissionPrescreener(risky, false);
    await expect(disabled('bash', {})).resolves.toBeNull();

    const off = createPermissionPrescreener(new DecisionService({}), true);
    await expect(off('bash', {})).resolves.toBeNull();
  });

  it('returns null when the backend throws — pre-screen never breaks the pipeline', async () => {
    const broken = new DecisionService({
      client: fakeClient(async () => {
        throw new Error('boom');
      }),
    });
    const prescreen = createPermissionPrescreener(broken, true);
    await expect(prescreen('bash', {})).resolves.toBeNull();
  });
});

describe('LlmDecisionFallback', () => {
  const REQUEST: DecisionRequest = {
    state: { page: 'settings' },
    questions: {
      done: { kind: 'noul', instructions: 'done?' },
      target: { kind: 'choice', instructions: 'which?', options: ['#1', '#2'] },
    },
  };

  it('parses a fenced JSON answer into typed answers', async () => {
    const llm = {
      chat: vi.fn(async () => ({
        content: '```json\n{"done": 0.9, "target": {"value": "#2"}}\n```',
      })),
    };
    const fallback = new LlmDecisionFallback({ llm });
    const res = await fallback.decide(REQUEST);
    expect(res.answers.done).toEqual({ kind: 'noul', p: 0.9 });
    expect(res.answers.target).toMatchObject({ kind: 'choice', value: '#2' });
  });

  it('throws on unparseable / off-list answers (caller falls to rules)', async () => {
    const garbage = new LlmDecisionFallback({ llm: { chat: async () => ({ content: 'I think so!' }) } });
    await expect(garbage.decide(REQUEST)).rejects.toThrow(/parseable JSON/);

    const offList = new LlmDecisionFallback({
      llm: { chat: async () => ({ content: '{"done": 0.9, "target": "#99"}' }) },
    });
    await expect(offList.decide(REQUEST)).rejects.toThrow(/one of the options/);
  });

  it('parseLlmDecision rejects partial answers', () => {
    expect(() => parseLlmDecision(REQUEST, '{"done": 0.9}')).toThrow(/missing/);
  });
});

describe('createDecisionServiceFromConfig', () => {
  it('disabled without config/env → available=false (no key, zero difference)', () => {
    const service = createDecisionServiceFromConfig({ config: { systemOne: { enabled: false } } });
    expect(service.available).toBe(false);
  });

  it('enabled with key → available primary client with configured budget', () => {
    const service = createDecisionServiceFromConfig({
      config: {
        systemOne: { enabled: true, apiKey: 'test-key', timeoutMs: 1234 },
        policy: { doneAt: 0.7 },
      },
    });
    expect(service.available).toBe(true);
    expect(service.policy.doneAt).toBe(0.7);
  });

  it('enabled without any key collapses to disabled', () => {
    const service = createDecisionServiceFromConfig({ config: { systemOne: { enabled: true } } });
    expect(service.available).toBe(false);
  });

  it('getDecisionService singleton is stable and resettable', () => {
    resetDecisionService();
    const a = getDecisionService();
    const b = getDecisionService();
    expect(a).toBe(b);
    resetDecisionService();
    expect(getDecisionService()).not.toBe(a);
  });
});

/**
 * engine.test.ts — fixture-level e2e over a mock host (plan 552 Phase 2
 * gate): every non-gui node kind runs end to end, journal cache economics
 * hold, human suspension resumes through signed tokens, and dry-run
 * produces a baseline without touching the host.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DecisionClient, DecisionRequest, DecisionResponse } from '@duya/ai';
import {
  WorkflowEngine,
  Journal,
  MemoryJournalSink,
  BudgetLedger,
  validateWorkflow,
  parseWorkflowDef,
  createResumeToken,
  verifyResumeToken,
  runGuiNode,
  MemoryArtifactStore,
  BudgetLedger,
  type WorkflowHost,
  type HostCallContext,
  type HostCallResult,
  type EngineOutcome,
} from '../index.js';
import { DecisionService } from '../../../decisions/index.js';
import { DEFAULT_DECIDE_LOOP_POLICY } from '../decision-adapter.js';

// ─── fixtures ───

interface HostScript {
  tools?: Record<string, (input: unknown, ctx: HostCallContext) => unknown>;
  agents?: Record<string, (prompt: string, ctx: HostCallContext) => unknown>;
  agentFailures?: Record<string, { error: string; times: number }>;
  approval?: 'approve' | 'deny' | 'timeout';
  decisions?: (req: DecisionRequest) => DecisionResponse;
}

function fixtureHost(script: HostScript): WorkflowHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runTool(tool, input, ctx) {
      calls.push(`tool:${tool}:${ctx.nodeId}`);
      const handler = script.tools?.[tool];
      if (!handler) return { ok: false, error: `unknown tool ${tool}`, errorClass: 'tool_missing' };
      return { ok: true, output: handler(input, ctx) };
    },
    async runAgent(spec, ctx) {
      calls.push(`agent:${spec.agent}:${ctx.nodeId}`);
      const failure = script.agentFailures?.[ctx.nodeId];
      if (failure && failure.times > 0) {
        failure.times--;
        return { ok: false, error: failure.error };
      }
      const handler = script.agents?.[spec.agent];
      if (!handler) return { ok: false, error: `unknown agent ${spec.agent}`, errorClass: 'agent_missing' };
      return { ok: true, output: handler(spec.prompt, ctx) };
    },
    async askDecision(state, questions) {
      calls.push(`decision:${Object.keys(questions).join('+')}`);
      if (!script.decisions) throw new Error('decision backend unavailable');
      return script.decisions({ state, questions });
    },
    async requestApproval(spec) {
      calls.push(`approval:${spec.nodeId}`);
      return { decision: script.approval ?? 'approve' };
    },
  };
}

function noul(p: number): DecisionResponse['answers'][string] {
  return { kind: 'noul', p };
}

function choice(value: string, p: number): DecisionResponse['answers'][string] {
  return { kind: 'choice', value, distribution: { [value]: p, filler: 1 - p }, confidence: p };
}

function fakeDecisionService(answers: DecisionResponse['answers']): DecisionService {
  const client: DecisionClient = {
    async decide(): Promise<DecisionResponse> {
      return { answers };
    },
  };
  return new DecisionService({ client, policy: DEFAULT_DECIDE_LOOP_POLICY });
}

const SIMPLE_DEF = parseWorkflowDef({
  name: 'simple',
  description: 'tool → agent → noop',
  phases: [
    {
      phase: 'work',
      title: 'Work',
      nodes: [
        { id: 'export', tool: 'excel.write', input: { rows: '${params.rows}' } },
        { id: 'report', agent: 'general-purpose', prompt: 'summarize ${export.output}' },
        { id: 'join', noop: true },
      ],
    },
  ],
});

// ─── happy paths ───

describe('happy path across kinds', () => {
  it('tool → agent → noop with interpolation and outputs', async () => {
    const host = fixtureHost({
      tools: { 'excel.write': (input) => ({ written: (input as { rows: unknown[] }).rows.length }) },
      agents: { 'general-purpose': (prompt) => ({ prompt }) },
    });
    const engine = new WorkflowEngine({ host });
    const outcome = await engine.execute(SIMPLE_DEF, { rows: [1, 2, 3] });
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs.export).toEqual({ written: 3 });
    expect((outcome.outputs.report as { prompt: string }).prompt).toContain('written');
  });

  it('records journal entries as they happen (one write, three uses)', async () => {
    const host = fixtureHost({
      tools: { 'excel.write': () => 'ok' },
    });
    const engine = new WorkflowEngine({ host });
    const outcome = await engine.execute(SIMPLE_DEF, { rows: [] });
    expect(outcome.status).toBe('complete');
    expect(host.calls).toEqual(['tool:excel.write:export', 'agent:general-purpose:report']);
  });
});

// ─── decision nodes (551 DecisionService consumption) ───

const ROUTE_DEF = parseWorkflowDef({
  name: 'route-ticket',
  description: 'decide then branch',
  params: [{ name: 'mail', type: 'json', required: true }],
  phases: [
    {
      phase: 'decide',
      title: 'Decide',
      nodes: [
        {
          id: 'route',
          decision: {
            state: { output: '${params.mail}' },
            questions: {
              department: { type: 'choice', criteria: { billing: 'Billing', tech: 'Tech' } },
              urgent: { type: 'noul', instructions: 'Time pressure?' },
            },
            thresholds: { urgent: 0.65 },
          },
        },
        { id: 'billing-path', tool: 'billing.assign', when: "route.department == 'billing' && route.urgent > 0.65" },
        { id: 'tech-path', tool: 'tech.assign', when: "route.department == 'tech'" },
      ],
    },
  ],
});

describe('decision nodes', () => {
  it('typed answers enter the when scope (552 §4.2 example)', async () => {
    const host = fixtureHost({
      tools: {
        'billing.assign': () => 'billing',
        'tech.assign': () => 'tech',
      },
    });
    const service = fakeDecisionService({ department: choice('billing', 0.92), urgent: noul(0.8) });
    const engine = new WorkflowEngine({ host, decisionService: service });
    const outcome = await engine.execute(ROUTE_DEF, { mail: { subject: 'invoice' } });
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs['billing-path']).toBe('billing');
    expect(outcome.outputs['tech-path']).toBeUndefined(); // when=false → skipped
    expect(outcome.outputs.route).toEqual({ department: 'billing', urgent: 0.8 });
  });

  it('gray band + on_low_confidence ask escalates to the human channel', async () => {
    const host = fixtureHost({
      tools: { 'billing.assign': () => 'billing', 'tech.assign': () => 'tech' },
      approval: 'approve',
    });
    const def = parseWorkflowDef({
      ...ROUTE_DEF,
      phases: [
        {
          ...ROUTE_DEF.phases[0],
          nodes: [
            {
              ...ROUTE_DEF.phases[0].nodes[0],
              decision: {
                ...ROUTE_DEF.phases[0].nodes[0].decision,
                on_low_confidence: 'ask' as const,
              },
            },
            ...ROUTE_DEF.phases[0].nodes.slice(1),
          ],
        },
      ],
    });
    // department lands in the gray band (0.5 < minTargetConfidence 0.8).
    const service = fakeDecisionService({ department: choice('billing', 0.5), urgent: noul(0.9) });
    const engine = new WorkflowEngine({ host, decisionService: service });
    const outcome = await engine.execute(def, { mail: {} });
    expect(outcome.status).toBe('complete');
    expect(host.calls.some((c) => c === 'approval:route')).toBe(true);
  });

  it('no decision backend → on_low_confidence default applies (zero-broken)', async () => {
    const host = fixtureHost({ tools: { 'billing.assign': () => 'b', 'tech.assign': () => 't' } });
    const def = parseWorkflowDef({
      ...ROUTE_DEF,
      phases: [
        {
          ...ROUTE_DEF.phases[0],
          nodes: [
            {
              ...ROUTE_DEF.phases[0].nodes[0],
              decision: {
                ...ROUTE_DEF.phases[0].nodes[0].decision,
                on_low_confidence: { default: 'tech' },
              },
            },
            ...ROUTE_DEF.phases[0].nodes.slice(1),
          ],
        },
      ],
    });
    const engine = new WorkflowEngine({ host }); // no decisionService
    const outcome = await engine.execute(def, { mail: {} });
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs['tech-path']).toBe('t');
  });
});

// ─── human nodes (§6.3) ───

const PAY_DEF = parseWorkflowDef({
  name: 'pay',
  description: 'approval gated payment',
  phases: [
    {
      phase: 'approve',
      title: 'Approve',
      nodes: [
        {
          id: 'approve-payment',
          human: { prompt: 'Pay ${params.amount}?', timeout: { hours: 24, on_timeout: 'fail' } },
        },
        { id: 'wire', tool: 'pay.send', when: 'approve-payment.approved == true' },
        { id: 'reject-note', tool: 'pay.note', when: 'approve-payment.approved == false' },
      ],
    },
  ],
});

describe('human nodes', () => {
  it('await mode: approval record + downstream reads approved', async () => {
    const host = fixtureHost({
      approval: 'approve',
      tools: { 'pay.send': () => 'sent', 'pay.note': () => 'noted' },
    });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host });
    const outcome = await engine.execute(PAY_DEF, { amount: 100 }, { journal });
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs.wire).toBe('sent');
    expect(journal.all().some((r) => r.kind === 'approval' && r.status === 'succeeded')).toBe(true);
  });

  it('suspend mode parks with a signed token; resume lands the decision', async () => {
    const host = fixtureHost({ tools: { 'pay.send': () => 'sent', 'pay.note': () => 'noted' } });
    const journal = new Journal(new MemoryJournalSink());
    const secret = 'test-secret';
    const engine = new WorkflowEngine({ host, secret, approvalMode: 'suspend' });
    const first = await engine.execute(PAY_DEF, { amount: 100 }, { journal });
    expect(first.status).toBe('waiting');
    if (first.status !== 'waiting') return;
    expect(first.nodeId).toBe('approve-payment');
    expect(verifyResumeToken(secret, first.resumeToken)?.nodeId).toBe('approve-payment');

    // Marker written BEFORE parking (§6.3).
    const marker = journal.all().find((r) => r.kind === 'approval' && r.nodeId === 'approve-payment');
    expect(marker?.status).toBe('waiting');

    const second = await engine.resume(
      PAY_DEF,
      { amount: 100 },
      journal,
      { token: first.resumeToken, decision: 'approve' },
    );
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    expect(second.outputs.wire).toBe('sent');
    // Host approval gate never fired synchronously (suspend semantics).
    expect(host.calls.some((c) => c.startsWith('approval:'))).toBe(false);
  });

  it('rejects a tampered token (timing-safe HMAC)', async () => {
    const host = fixtureHost({});
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host, secret: 'test-secret', approvalMode: 'suspend' });
    const first = await engine.execute(PAY_DEF, { amount: 1 }, { journal });
    if (first.status !== 'waiting') throw new Error('expected waiting');
    const forged = `${first.resumeToken.slice(0, -2)}xx`;
    const outcome = await engine.resume(PAY_DEF, { amount: 1 }, journal, {
      token: forged,
      decision: 'approve',
    });
    expect(outcome.status).toBe('failed');
    expect((outcome as { error?: string }).error).toContain('invalid resume token');
  });

  it('timeout decision applies on_timeout=fail', async () => {
    const host = fixtureHost({});
    const journal = new Journal(new MemoryJournalSink());
    const secret = 's';
    const engine = new WorkflowEngine({ host, secret, approvalMode: 'suspend' });
    const first = await engine.execute(PAY_DEF, { amount: 1 }, { journal });
    if (first.status !== 'waiting') throw new Error('expected waiting');
    const token = createResumeToken(secret, { runId: first.runId, nodeId: 'approve-payment', issuedAt: Date.now() });
    const outcome = await engine.resume(PAY_DEF, { amount: 1 }, journal, { token, decision: 'timeout' });
    expect(outcome.status).toBe('failed');
    expect((outcome as { errorClass?: string }).errorClass).toBe('approval_timeout');
  });
});

// ─── map fan-out ───

const MAP_DEF = parseWorkflowDef({
  name: 'fanout',
  description: 'map over tool results',
  params: [{ name: 'items', type: 'json', required: true }],
  phases: [
    {
      phase: 'work',
      title: 'Work',
      nodes: [
        {
          id: 'handle',
          agent: 'general-purpose',
          prompt: 'handle ${item}',
          map: { over: 'params.items', as: 'item' },
        },
        { id: 'summarize', agent: 'general-purpose', prompt: 'sum ${handle.output}' },
      ],
    },
  ],
});

describe('map runner', () => {
  it('fans out, soft-fails failed items to null, siblings continue', async () => {
    const host = fixtureHost({});
    // Item "b" fails at the host level (grok parallel soft-fail path).
    const failingHost: WorkflowHost = {
      ...host,
      async runAgent(spec) {
        if (spec.prompt === 'handle b') {
          return { ok: false, error: 'boom', errorClass: 'tool_error' };
        }
        return { ok: true, output: `done:${spec.prompt}` };
      },
    };
    const engine = new WorkflowEngine({ host: failingHost });
    const outcome = await engine.execute(MAP_DEF, { items: ['a', 'b', 'c'] });
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    const results = outcome.outputs.handle as unknown[];
    expect(results).toHaveLength(3);
    expect(results[0]).toBe('done:handle a');
    expect(results[1]).toBeNull(); // soft-failed item
    expect(results[2]).toBe('done:handle c');
  });

  it('per-item journal cache avoids re-paying unchanged items', async () => {
    const host = fixtureHost({
      agents: { 'general-purpose': (prompt) => `done:${prompt}` },
    });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host });
    await engine.execute(MAP_DEF, { items: ['a', 'b'] }, { journal });
    const firstCalls = host.calls.length;

    // Same params → every node hits the cache: zero host calls.
    await engine.execute(MAP_DEF, { items: ['a', 'b'] }, { journal });
    expect(host.calls.length).toBe(firstCalls);
  });
});

// ─── on_error policy ───

describe('on_error dynamic policy', () => {
  it('retryable transient errors consume max_retries then succeed', async () => {
    const def = parseWorkflowDef({
      name: 'retry',
      description: 'flaky tool',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'flaky', tool: 'flaky.call', on_error: 'retry', max_retries: 2 },
          ],
        },
      ],
    });
    const host = fixtureHost({});
    // First two calls fail transiently, then succeed.
    let attempts = 0;
    const wrappedHost: WorkflowHost = {
      ...host,
      async runTool(tool, input, ctx) {
        attempts++;
        if (attempts <= 2) return { ok: false, error: '503 overloaded', errorClass: 'transient' };
        return { ok: true, output: 'recovered' };
      },
    };
    const engine = new WorkflowEngine({ host: wrappedHost });
    const outcome = await engine.execute(def, {});
    expect(outcome.status).toBe('complete');
    expect(attempts).toBe(3);
  });

  it('on_error=skip records and continues; fail stops the run', async () => {
    const def = parseWorkflowDef({
      name: 'err',
      description: 'error dispositions',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [{ id: 'broken', tool: 'missing.tool' }],
        },
      ],
    });
    const host = fixtureHost({});
    const skipEngine = new WorkflowEngine({ host });
    const skipOutcome = await skipEngine.execute(def, {});
    expect(skipOutcome.status).toBe('complete'); // default skip

    const failDef = parseWorkflowDef({
      ...def,
      phases: [
        { ...def.phases[0], nodes: [{ ...def.phases[0].nodes[0], on_error: 'fail' as const }] },
      ],
    });
    const failEngine = new WorkflowEngine({ host });
    const failOutcome = await failEngine.execute(failDef, {});
    expect(failOutcome.status).toBe('failed');
    if (failOutcome.status === 'failed') {
      expect(failOutcome.errorClass).toBe('tool_missing');
    }
  });
});

// ─── cache economics + budget + cancel ───

describe('cache economics (§6.4)', () => {
  it('params change re-pays only affected nodes', async () => {
    const def = parseWorkflowDef({
      name: 'econ',
      description: 'params isolation',
      params: [{ name: 'q', type: 'string', required: true }],
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'a', tool: 'a.call', input: { q: '${params.q}' } },
            { id: 'b', tool: 'b.call' },
          ],
        },
      ],
    });
    const host = fixtureHost({
      tools: { 'a.call': () => 'a', 'b.call': () => 'b' },
    });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host });
    await engine.execute(def, { q: 'one' }, { journal });
    const afterFirst = host.calls.length;

    await engine.execute(def, { q: 'two' }, { journal });
    // Only node `a` (references params.q) re-executed.
    expect(host.calls.length).toBe(afterFirst + 1);
    expect(host.calls[afterFirst]).toBe('tool:a.call:a');
  });

  it('budget exhaustion stops journal-free (replayable)', async () => {
    const def = parseWorkflowDef({
      name: 'budget',
      description: 'budget stop',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [{ id: 'a', agent: 'general-purpose', prompt: 'x' }],
        },
      ],
    });
    const host = fixtureHost({ agents: { 'general-purpose': () => 'ok' } });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host, agentBudget: 0 });
    const outcome = await engine.execute(def, {}, { journal });
    expect(outcome.status).toBe('failed');
    expect((outcome as { errorClass?: string }).errorClass).toBe('budget_exceeded');
  });

  it('abort signal cancels between nodes without journal failure', async () => {
    const def = SIMPLE_DEF;
    const host = fixtureHost({ tools: { 'excel.write': () => 'ok' } });
    const controller = new AbortController();
    controller.abort();
    const engine = new WorkflowEngine({ host, signal: controller.signal });
    const outcome = await engine.execute(def, { rows: [] });
    expect(outcome.status).toBe('cancelled');
  });
});

// ─── dry-run baseline (§10.3) ───

describe('dry-run mode', () => {
  it('plans every node without touching the host', async () => {
    const host = fixtureHost({ tools: { 'excel.write': () => 'REAL' } });
    const engine = new WorkflowEngine({ host, dryRun: true });
    const outcome = await engine.execute(SIMPLE_DEF, { rows: [1] });
    expect(outcome.status).toBe('complete');
    expect(host.calls).toHaveLength(0); // nothing executed
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs.export).toEqual({ dryRun: true, tool: 'excel.write', input: { rows: [1] } });
    expect(outcome.outputs.report).toMatchObject({ dryRun: true, agent: 'general-purpose' });
  });

  it('human nodes resolve as unconfirmed without a human', async () => {
    const host = fixtureHost({});
    const engine = new WorkflowEngine({ host, dryRun: true });
    const outcome = await engine.execute(PAY_DEF, { amount: 5 });
    expect(outcome.status).toBe('complete');
    expect(host.calls).toHaveLength(0);
    if (outcome.status !== 'complete') return;
    expect(outcome.outputs['approve-payment']).toMatchObject({ dryRun: true });
  });
});

// ─── resume token contract ───

describe('resume tokens', () => {
  it('verify → payload; wrong secret → null', () => {
    const token = createResumeToken('k', { runId: 'r1', nodeId: 'n1', issuedAt: 1 });
    expect(verifyResumeToken('k', token)?.runId).toBe('r1');
    expect(verifyResumeToken('other', token)).toBeNull();
    expect(verifyResumeToken('k', 'garbage')).toBeNull();
  });
});

// ─── budget ledger reserve→release ───

describe('BudgetLedger', () => {
  it('reserve→release refunds; reserve→commit books', () => {
    const ledger = new BudgetLedger(1, 100);
    const t1 = ledger.reserveAgent();
    ledger.commit(t1);
    expect(() => ledger.reserveAgent()).toThrow(/budget exceeded/i);
  });
});

// ─── step-evidence annotations (plan 552 Phase 7 console) ───

describe('journal step evidence', () => {
  it('tool/agent records carry nodeKind, action, timing and output size', async () => {
    const host = fixtureHost({
      tools: { 'excel.write': () => ({ written: 3 }) },
      agents: { 'general-purpose': (prompt) => ({ prompt }) },
    });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host });
    await engine.execute(SIMPLE_DEF, { rows: [1] }, { journal });

    const toolRecord = journal.all().find((r) => r.nodeId === 'export')!;
    expect(toolRecord.nodeKind).toBe('tool');
    expect(toolRecord.action).toBe('excel.write');
    expect(typeof toolRecord.durationMs).toBe('number');
    expect(toolRecord.outputSize).toBeGreaterThan(0);

    const agentRecord = journal.all().find((r) => r.nodeId === 'report')!;
    expect(agentRecord.nodeKind).toBe('agent');
    expect(agentRecord.action).toBe('general-purpose');

    // Evidence never rides the cache key: a re-run still hits the cache.
    const before = host.calls.length;
    await engine.execute(SIMPLE_DEF, { rows: [1] }, { journal });
    expect(host.calls.length).toBe(before);
  });

  it('human records are annotated as human/approval', async () => {
    const host = fixtureHost({ approval: 'approve' });
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host });
    await engine.execute(PAY_DEF, { amount: 1 }, { journal });
    const approval = journal.all().find((r) => r.kind === 'approval' && r.status === 'succeeded')!;
    expect(approval.nodeKind).toBe('human');
    expect(approval.action).toBe('approval');
  });

  it('host exitCode / childSessionId / usage ride the record', async () => {
    const host = fixtureHost({
      tools: {
        'excel.write': () => ({ written: 1 }),
      },
    });
    const wrapped: WorkflowHost = {
      ...host,
      async runTool(tool, input, ctx) {
        const r = await host.runTool(tool, input, ctx);
        return { ...r, exitCode: 0, childSessionId: 'child-sess-1', usage: { inputTokens: 10, outputTokens: 4 } };
      },
    };
    const journal = new Journal(new MemoryJournalSink());
    const engine = new WorkflowEngine({ host: wrapped });
    await engine.execute(SIMPLE_DEF, { rows: [] }, { journal });
    const record = journal.all().find((r) => r.nodeId === 'export')!;
    expect(record.exitCode).toBe(0);
    expect(record.childSessionId).toBe('child-sess-1');
    expect(record.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('gui step + screenshot records carry gui evidence', async () => {
    const journal = new Journal(new MemoryJournalSink());
    const outcome = await runGuiNode({
      nodeId: 'fill',
      gui: { target_app: 'ERP*', steps: [{ do: 'click', element: 'som:1', verify: true }], on_stuck: 'fail' },
      scope: { resolve: () => undefined },
      host: fixtureHost({}),
      journal,
      budget: new BudgetLedger(4, 100),
      ports: {
        backend: { step: async () => ({ ok: true, effect: 'confirmed' }), capture: async () => ({ base64: 'PNG' }) },
        artifacts: new MemoryArtifactStore(),
      },
      approvalMode: 'await',
      runId: 'r-gui',
    });
    expect(outcome.status).toBe('succeeded');
    const stepRecord = journal.all().find((r) => r.kind === 'node_result' && r.status === 'succeeded')!;
    expect(stepRecord.nodeKind).toBe('gui');
    expect(stepRecord.action).toBe('click');
    expect(typeof stepRecord.durationMs).toBe('number');
    const shot = journal.all().find((r) => r.kind === 'artifact')!;
    expect(shot.action).toBe('capture');
    expect(shot.outputSize).toBe(3);
  });
});

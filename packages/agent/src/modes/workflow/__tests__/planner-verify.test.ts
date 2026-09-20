/**
 * planner-verify.test.ts — plan 552 Phase 5 gate: plan → validate →
 * high-risk stop, and the three-tier verify ladder with verified/
 * unconfirmed journal annotations.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DecisionClient, DecisionResponse } from '@duya/ai';
import {
  WorkflowPlanner,
  runVerifyStage,
  summarizeRun,
  Journal,
  MemoryJournalSink,
  parseWorkflowDef,
  type WorkflowHost,
} from '../index.js';
import { DecisionService } from '../../../decisions/index.js';

function noul(p: number): DecisionResponse['answers'][string] {
  return { kind: 'noul', p };
}

function fakeDecisionService(answers: DecisionResponse['answers']): DecisionService {
  const client: DecisionClient = {
    async decide(): Promise<DecisionResponse> {
      return { answers };
    },
  };
  return new DecisionService({ client });
}

const GOOD_YAML = `
name: invoice-sync
description: Pull invoices and file them
phases:
  - phase: work
    title: Work
    nodes:
      - id: fetch
        tool: fs.read
        input: { path: "\${params.src}" }
      - id: report
        agent: general-purpose
        prompt: "File \${fetch.output}"
      - id: done
        noop: true
`;

describe('WorkflowPlanner', () => {
  it('LLM YAML → validated def (plan → validate chain)', async () => {
    const planner = new WorkflowPlanner(async () => GOOD_YAML);
    const result = await planner.plan({ goal: 'file invoices' });
    expect(result.def.name).toBe('invoice-sync');
    expect(result.highRiskNodes).toEqual([]);
  });

  it('invalid YAML retries ONCE with the error list, then succeeds', async () => {
    const prompts: string[] = [];
    const planner = new WorkflowPlanner(async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) return 'name: [broken';
      return GOOD_YAML;
    });
    const result = await planner.plan({ goal: 'file invoices' });
    expect(result.def.phases).toHaveLength(1);
    expect(prompts[1]).toContain('INVALID');
    expect(prompts[1]).toContain('YAML parse error');
  });

  it('two failures abort planning (never a half-baked plan)', async () => {
    const planner = new WorkflowPlanner(async () => 'name: [broken');
    await expect(planner.plan({ goal: 'x' })).rejects.toThrow(/planner failed after retry/);
  });

  it('rule pass flags irreversible-shaped tool names (high-risk stop)', async () => {
    const planner = new WorkflowPlanner(async () => GOOD_YAML);
    const def = parseWorkflowDef({
      name: 'pay-run',
      description: 'x',
      phases: [
        { phase: 'p', title: 'P', nodes: [{ id: 'send-money', tool: 'pay.send' }] },
      ],
    });
    const { highRiskNodes } = await planner.prescreenRisk(def);
    expect(highRiskNodes).toEqual(['send-money']);
  });

  it('gui nodes default to high-risk (conservative without prescreen evidence)', async () => {
    const planner = new WorkflowPlanner(async () => GOOD_YAML);
    const def = parseWorkflowDef({
      name: 'gui-run',
      description: 'x',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'fill', gui: { target_app: 'ERP*', steps: [{ do: 'click', element: 'som:1' }] } },
          ],
        },
      ],
    });
    const { highRiskNodes } = await planner.prescreenRisk(def);
    expect(highRiskNodes).toContain('fill');
  });

  it('Jev pass flags irreversible agents (p ≥ threshold) — suggestion only', async () => {
    const planner = new WorkflowPlanner(
      async () => GOOD_YAML,
      fakeDecisionService({ risk: noul(0.9) }),
    );
    const def = parseWorkflowDef({
      name: 'agent-run',
      description: 'x',
      phases: [
        { phase: 'p', title: 'P', nodes: [{ id: 'act', agent: 'general-purpose', prompt: 'do it' }] },
      ],
    });
    const { highRiskNodes } = await planner.prescreenRisk(def);
    expect(highRiskNodes).toEqual(['act']);
  });
});

// ─── verify ladder ───

function baseVerify(overrides?: Partial<Parameters<typeof runVerifyStage>[0]>) {
  const def = parseWorkflowDef({
    name: 'v',
    description: 'Do the thing',
    phases: [
      {
        phase: 'p',
        title: 'P',
        nodes: [
          { id: 'a', tool: 'x.call' },
          { id: 'b', noop: true },
        ],
      },
    ],
  });
  const host: WorkflowHost = {
    runAgent: vi.fn(async () => ({ ok: true, output: { verified: true, reason: 'evidence matches' } })),
    runTool: async () => ({ ok: true, output: null }),
    requestApproval: async () => ({ decision: 'approve' as const }),
  };
  const options = {
    def,
    outputs: { a: 'result', b: null },
    journal: new Journal(new MemoryJournalSink()),
    runId: 'r1',
    host,
    ...overrides,
  };
  return options;
}

describe('runVerifyStage — three tiers', () => {
  it('tier 0 deterministic: verified journal annotations settle it', async () => {
    const options = baseVerify();
    // Seed verified annotations (e.g. gui confirm effects).
    options.journal.append({
      kind: 'node_result', nodeId: 'a', attempt: 1, reqHash: 'h1', status: 'succeeded', result: null, verification: 'verified',
    });
    const verdict = await runVerifyStage(options);
    expect(verdict.tier).toBe('deterministic');
    expect(verdict.verification).toBe('verified');
    expect(options.host.runAgent).not.toHaveBeenCalled();
  });

  it('tier 1 decision: Jev verify question over the machine summary', async () => {
    const service = fakeDecisionService({ done: noul(0.95) });
    const options = baseVerify({ decisionService: service });
    const verdict = await runVerifyStage(options);
    expect(verdict.tier).toBe('decision');
    expect(verdict.verification).toBe('verified');
  });

  it('tier 2 agent: decision uncertainty escalates to a fresh-eyes agent', async () => {
    const service = fakeDecisionService({ done: noul(0.6) }); // gray band
    const options = baseVerify({ decisionService: service });
    const verdict = await runVerifyStage(options);
    expect(verdict.tier).toBe('agent');
    expect(verdict.verification).toBe('verified');
  });

  it('failed runs are never verified (unconfirmed at best)', async () => {
    const options = baseVerify();
    options.journal.append({
      kind: 'node_result', nodeId: 'a', attempt: 1, status: 'failed', result: null, errorClass: 'tool_error',
    });
    const verdict = await runVerifyStage({ ...options, outputs: {} });
    expect(verdict.verification).toBe('unconfirmed');
  });

  it('the verdict lands a journal record with the annotation', async () => {
    const options = baseVerify({ dryRun: true });
    await runVerifyStage(options);
    const record = options.journal.all().find((r) => r.nodeId === '__verify__');
    expect(record?.verification).toBe('unconfirmed');
  });

  it('summarizeRun is pure code (machine-computed, no model)', () => {
    const def = parseWorkflowDef({
      name: 's',
      description: 'x',
      phases: [
        { phase: 'p', title: 'P', nodes: [{ id: 'a', tool: 'x' }, { id: 'b', noop: true }] },
      ],
    });
    expect(summarizeRun(def, { a: 1 })).toEqual({ totalNodes: 2, succeeded: 1, missing: 1, nodeIds: ['a', 'b'] });
  });
});

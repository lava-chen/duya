/**
 * schema-validate.test.ts — workflow definition schema + static semantic
 * validation (plan 552 Phase 1).
 *
 * Covers: six node kinds round-trip, exactly-one-kind refiner, human
 * timeout required (anti-suspension-leak), determinism (no wait step),
 * reference legality (nodes / params / map var), cycle detection,
 * cross-phase forward-reference rejection, and decision coherence.
 */

import { describe, it, expect } from 'vitest';
import { parseWorkflowDef, validateWorkflow, GuiStepSchema } from '../index.js';
import type { WorkflowDef } from '../index.js';

function baseDef(overrides?: Partial<WorkflowDef>): unknown {
  return {
    name: 'invoice-sync',
    description: 'Sync invoices into the ERP',
    when_to_use: 'When invoices arrive',
    phases: [
      {
        phase: 'work',
        title: 'Work',
        nodes: [{ id: 'noop-1', noop: true }],
      },
    ],
    ...overrides,
  };
}

describe('schema shape', () => {
  it('accepts a minimal valid def', () => {
    expect(() => parseWorkflowDef(baseDef())).not.toThrow();
  });

  it('enforces kebab-case name and ≤64 chars', () => {
    expect(() => parseWorkflowDef(baseDef({ name: 'Bad_Name' }))).toThrow();
    expect(() => parseWorkflowDef(baseDef({ name: 'a'.repeat(65) }))).toThrow();
  });

  it('enforces ≤8 phases', () => {
    const phases = Array.from({ length: 9 }, (_, i) => ({
      phase: `p${i}`,
      title: 'P',
      nodes: [{ id: `n${i}`, noop: true }],
    }));
    expect(() => parseWorkflowDef(baseDef({ phases }))).toThrow();
  });

  it('requires exactly one node kind', () => {
    const bad = baseDef({
      phases: [{ phase: 'p', title: 'P', nodes: [{ id: 'a', noop: true, tool: 'x' }] }],
    });
    expect(validateWorkflow(bad).ok).toBe(false);
  });

  it('map may wrap exactly one agent', () => {
    const ok = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'src', tool: 'fs.list' },
            {
              id: 'fan',
              agent: 'general-purpose',
              prompt: 'handle ${item}',
              map: { over: 'src.output', as: 'item' },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(ok).ok).toBe(true);
  });

  it('human node requires timeout.on_timeout (schema-enforced)', () => {
    const bad = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [{ id: 'approve', human: { prompt: 'Pay?' } as never }],
        },
      ],
    });
    expect(validateWorkflow(bad).ok).toBe(false);

    const good = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            {
              id: 'approve',
              human: { prompt: 'Pay ${params.amount}?', timeout: { hours: 24, on_timeout: 'escalate' } },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(good).ok).toBe(true);
  });

  it('gui steps have no wait — determinism rule §6.5', () => {
    expect(GuiStepSchema.safeParse({ do: 'wait', ms: 500 }).success).toBe(false);
    expect(GuiStepSchema.safeParse({ do: 'capture' }).success).toBe(true);
    expect(GuiStepSchema.safeParse({ do: 'click', element: 'som:3' }).success).toBe(true);
    expect(GuiStepSchema.safeParse({ do: 'click', element: '#3' }).success).toBe(false);
  });

  it('params carry types; triggers are a closed union', () => {
    const def = baseDef({
      params: [{ name: 'invoice_id', type: 'string', required: true }],
      triggers: [{ cron: '0 9 * * 1-5' }],
    });
    expect(() => parseWorkflowDef(def)).not.toThrow();

    const badTrigger = baseDef({ triggers: [{ webhook: 'x' } as never] });
    expect(validateWorkflow(badTrigger).ok).toBe(false);
  });
});

describe('reference legality', () => {
  it('when / map.over refs must name nodes, params, or the loop var', () => {
    const bad = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'a', tool: 'x', when: 'ghost.output == 1' },
            { id: 'b', tool: 'x', map: { over: 'nowhere.output', as: 'it' } },
          ],
        },
      ],
    });
    const res = validateWorkflow(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('"ghost"'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('"nowhere"'))).toBe(true);
  });

  it('template holes in prompts / inputs / gui text are validated', () => {
    const bad = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'a', tool: 'x', input: { q: '${nope.ref}' } },
            {
              id: 'g',
              gui: {
                target_app: 'ERP*',
                steps: [{ do: 'type_text', text: '${phantom.v}' }],
              },
            },
          ],
        },
      ],
    });
    const res = validateWorkflow(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('"nope"'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('"phantom"'))).toBe(true);
  });

  it('map loop variables are legal inside fan-out templates', () => {
    const good = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'src', tool: 'fs.list' },
            {
              id: 'fan',
              agent: 'general-purpose',
              prompt: 'process ${item} for ${params.tenant}',
              map: { over: 'src.output', as: 'item' },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(good).ok).toBe(true);
  });
});

describe('ordering and cycles', () => {
  it('rejects dependency cycles', () => {
    const bad = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'a', tool: 'x', when: 'b.output == 1' },
            { id: 'b', tool: 'x', when: 'a.output == 1' },
          ],
        },
      ],
    });
    const res = validateWorkflow(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects references into later phases (sequential phases)', () => {
    const bad = baseDef({
      phases: [
        { phase: 'p1', title: 'P1', nodes: [{ id: 'a', tool: 'x', when: 'late.output == 1' }] },
        { phase: 'p2', title: 'P2', nodes: [{ id: 'late', tool: 'x' }] },
      ],
    });
    const res = validateWorkflow(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('later phase'))).toBe(true);
  });

  it('same-phase forward refs are fine (engine topological order)', () => {
    const good = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            { id: 'a', tool: 'x', when: 'b.output == 1' },
            { id: 'b', tool: 'x' },
          ],
        },
      ],
    });
    expect(validateWorkflow(good).ok).toBe(true);
  });
});

describe('decision node coherence', () => {
  it('threshold keys must name questions; choice needs ≥2 options; defaults validated', () => {
    const bad = baseDef({
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            {
              id: 'route',
              decision: {
                state: { output: '${upstream.output}' },
                questions: {
                  dept: { type: 'choice', criteria: { billing: 'b', tech: 't' } },
                },
                thresholds: { unknown_q: 0.5 },
                on_low_confidence: { default: 'nope' },
              },
            },
          ],
        },
      ],
    });
    const res = validateWorkflow(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('unknown question'))).toBe(true);
    expect(res.errors.some((e) => e.message.includes('not one of the choice options'))).toBe(true);
  });

  it('a coherent decision node passes', () => {
    const good = baseDef({
      params: [{ name: 'mail', type: 'json', required: true }],
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [
            {
              id: 'route',
              decision: {
                state: { output: '${params.mail}' },
                questions: {
                  department: { type: 'choice', criteria: { billing: 'Billing team', tech: 'Tech team' } },
                  urgent: { type: 'noul', instructions: 'Expresses time pressure?' },
                },
                thresholds: { urgent: 0.65 },
                on_low_confidence: { default: 'tech' },
              },
            },
            { id: 'billing', tool: 'x', when: "route.department == 'billing' && route.urgent > 0.65" },
          ],
        },
      ],
    });
    expect(validateWorkflow(good).ok).toBe(true);
  });
});

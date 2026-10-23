/**
 * worker-resource-budget.test.ts — the ceilings a run is held to, and whether
 * anyone is counting them.
 *
 * ## The finding this pins
 *
 * The protocol's `budget` field carried `max_turns` and nothing else, and the
 * host's own `BudgetLedger` only counted workflow agent invocations. So the
 * product had ceilings it did not measure (tokens, file writes, external
 * effects), ceilings it measured somewhere else entirely (the worker pool's
 * concurrency cap, the worker's V8 heap cap), and no way at all for a reader
 * of a run row to tell the two apart.
 *
 * A limit that nothing counts is not a limit. It is a number in a config
 * file, and a run row that carries it reads like a guarantee.
 *
 * ## What is pinned here
 *
 *  1. Every ceiling is marked `measured` or `unmeasured`, and an
 *     `unmeasured` one says why. No ceiling is both uncounted and unmarked.
 *  2. A ceiling marked `measured` is measured FOR REAL: the test checks the
 *     recorded limit against the LIVE host policy, not against a constant in
 *     this file. A flag flipped without a limit behind it fails here.
 *  3. The per-task ledger counts and refuses. A ceiling with a counter behind
 *     it is enforced at the point of use.
 */

import { describe, expect, it } from 'vitest';
import { buildRunManifest } from '../src/manifest-factory.js';
import {
  ResourceBudgetExceededError,
  TaskResourceBudget,
  resolveBudgetCeilings,
  type ResourceBudgetPolicy,
} from '../src/authorization/resource-budget.js';
import {
  calculateMaxConcurrentWorkers,
  getWorkerMaxMemoryMB,
} from '../src/worker-limits.js';

const BASE = { sessionId: 's-1', workingDirectory: '/repo' } as const;

/** The ceilings the product can actually count today. */
const MEASURED_CEILINGS = ['turns', 'cpuMemory', 'concurrency'] as const;

describe('the manifest records which ceilings are measured and which are not', () => {
  it('records which resource ceilings are measured and which are not', () => {
    const { manifest } = buildRunManifest({ ...BASE, maxTurns: 12 });

    const ceilings = manifest.budgetCeilings;
    expect(ceilings).toBeDefined();
    if (ceilings === undefined) return;

    // Every ceiling is accounted for. The card's rule: no ceiling may be
    // both unmeasured and unmarked.
    for (const [ceiling, record] of Object.entries(ceilings)) {
      expect(
        record.status === 'measured' || record.status === 'unmeasured',
        `ceiling ${ceiling} must be marked measured or unmeasured`,
      ).toBe(true);
      if (record.status === 'unmeasured') {
        expect(record.reason, `ceiling ${ceiling} must say why it is unmeasured`).toBeTruthy();
      }
    }

    // And the same status is in the provenance, per ceiling.
    const items = manifest.provenance.budget.items;
    expect(items).toBeDefined();
    if (items === undefined) return;
    for (const [ceiling, record] of Object.entries(ceilings)) {
      expect(items[ceiling]).toBe(record.status);
    }
  });

  it('marks a ceiling measured only when a live policy carries a limit for it', () => {
    // The status is DERIVED, so a flag cannot be flipped by hand: the only
    // way to make a ceiling measured is to give it a limit.
    const empty: ResourceBudgetPolicy = { limits: {}, enforcement: {} };
    const ceilings = resolveBudgetCeilings(empty);
    for (const record of Object.values(ceilings)) {
      expect(record.status).toBe('unmeasured');
    }
  });

  it('checks the recorded limits against the live host policy, not a constant', () => {
    // This is the assertion that makes the marking falsifiable. If somebody
    // marks `tokens` measured — or writes a hard-coded limit — the recorded
    // value stops matching the policy the host actually applies.
    const { manifest } = buildRunManifest({ ...BASE, maxTurns: 12 });
    const ceilings = manifest.budgetCeilings;
    expect(ceilings).toBeDefined();
    if (ceilings === undefined) return;

    expect(ceilings.turns.status).toBe('measured');
    expect(ceilings.turns.limit).toBe(12);

    expect(ceilings.cpuMemory.status).toBe('measured');
    expect(ceilings.cpuMemory.limit).toBe(getWorkerMaxMemoryMB());

    expect(ceilings.concurrency.status).toBe('measured');
    expect(ceilings.concurrency.limit).toBe(calculateMaxConcurrentWorkers());

    // The ceilings the product has no counter for are unmeasured, and stay
    // that way until one exists.
    for (const ceiling of ['tokens', 'fileWrites', 'externalEffects'] as const) {
      expect(ceilings[ceiling].status, `${ceiling} must stay unmeasured`).toBe('unmeasured');
      expect(ceilings[ceiling].limit).toBeUndefined();
    }
  });

  it('records a run with no turn ceiling as having none', () => {
    const { manifest } = buildRunManifest(BASE);
    const ceilings = manifest.budgetCeilings;
    expect(ceilings).toBeDefined();
    if (ceilings === undefined) return;
    expect(ceilings.turns.status).toBe('unmeasured');
    expect(manifest.budget).toEqual({});
  });
});

describe('the per-task ledger counts and refuses', () => {
  it('refuses a task that exhausts its ceiling', () => {
    const budget = new TaskResourceBudget({ maxToolCalls: 2, maxShellCommands: 1 });

    budget.countToolCall();
    budget.countToolCall();
    expect(() => budget.countToolCall()).toThrow(ResourceBudgetExceededError);

    budget.countShellCommand();
    expect(() => budget.countShellCommand()).toThrow(ResourceBudgetExceededError);
  });

  it('reports what the task used', () => {
    const budget = new TaskResourceBudget({ maxFileWrites: 1, maxExternalEffects: 1 });
    budget.countFileWrite();
    budget.countExternalEffect();
    expect(budget.usage).toEqual({
      toolCalls: 0,
      shellCommands: 0,
      fileWrites: 1,
      externalEffects: 1,
    });
  });

  it('does not refuse a task with no ceiling configured', () => {
    // An absent limit means "no ceiling", never "a ceiling of zero". A limit
    // that is not configured is recorded as unmeasured, and it does not fire.
    const budget = new TaskResourceBudget();
    for (let i = 0; i < 100; i += 1) {
      budget.countToolCall();
      budget.countFileWrite();
    }
    expect(budget.usage.toolCalls).toBe(100);
  });

  it('names the ceiling and the numbers in the refusal', () => {
    const budget = new TaskResourceBudget({ maxExternalEffects: 1 });
    budget.countExternalEffect();
    try {
      budget.countExternalEffect();
      expect.unreachable('the second external effect must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceBudgetExceededError);
      const exceeded = error as ResourceBudgetExceededError;
      expect(exceeded.ceiling).toBe('externalEffects');
      expect(exceeded.limit).toBe(1);
      expect(exceeded.observed).toBe(2);
    }
  });
});

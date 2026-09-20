/**
 * decide.test.ts — plan 551 Phase 3 gate (offline fixtures, no network,
 * no real backend — jev-browser bench shape).
 *
 * Covers describe state construction, the fan-out question template,
 * every status-contract branch of the inner loop, both confirm gates,
 * and the verdict bridge.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DecisionResponse } from '@duya/ai';
import {
  describePage,
  pageStateToDecisionState,
  buildRoundQuestions,
  buildStrictConfirmationQuestion,
  runDecideLoop,
  parseElementIndex,
  actionForTarget,
  createExecutorConfirmGate,
  createBridgeConfirmGate,
  assessVerdict,
  type DecideLoopPorts,
  type DecideActResult,
} from '../index.js';
import type { CaptureResult, SomElement } from '../../backend/types.js';
import type { ApprovalBridge, ApprovalRequest, ApprovalResult } from '../../approval/index.js';

// ─── fixtures ───

function element(index: number, label: string, kind?: string, x = 100, y = 100): SomElement {
  return { index, label, kind, bbox: { x: x - 25, y: y - 10, w: 50, h: 20 } };
}

function capture(elements: SomElement[]): CaptureResult {
  return {
    base64: '',
    width: 1280,
    height: 800,
    elements,
    displayId: 0,
    capturedAt: '2026-09-19T00:00:00.000Z',
  };
}

function noul(p: number): DecisionResponse['answers'][string] {
  return { kind: 'noul', p };
}

function choice(value: string, p: number): DecisionResponse['answers'][string] {
  return { kind: 'choice', value, distribution: { [value]: p, filler: 1 - p }, confidence: p };
}

/** Ports with a scripted ask() sequence; records actions. */
function scriptedPorts(
  rounds: DecisionResponse[],
  opts?: { actResults?: DecideActResult[]; confirm?: (action: unknown) => Promise<boolean> },
): DecideLoopPorts & { actions: Array<Record<string, unknown>>; askCount: number } {
  let round = 0;
  let actIdx = 0;
  const state = {
    actions: [] as Array<Record<string, unknown>>,
    askCount: 0,
  };
  const ports: DecideLoopPorts = {
    settle: async () => {},
    capture: async () => capture([element(1, 'OK', 'Button'), element(2, 'Email', 'Edit')]),
    ask: async (_state, questions) => {
      state.askCount++;
      void questions;
      const res = rounds[Math.min(round, rounds.length - 1)];
      round++;
      return res;
    },
    act: async (action) => {
      state.actions.push({ ...action });
      const res = opts?.actResults?.[actIdx] ?? { ok: true, verdictEffect: 'confirmed' };
      actIdx++;
      return res;
    },
    confirm: opts?.confirm,
  };
  return Object.assign(ports, state);
}

const OK_TARGET = '#1 [Button] "OK"';

// ─── describe ───

describe('describePage', () => {
  it('builds element labels, metrics, and repeated-element counts', () => {
    const page = describePage(
      capture([element(1, 'Submit', 'Button'), element(2, 'Submit', 'Button'), element(3, 'Email', 'Edit')]),
    );
    expect(page.elements).toHaveLength(3);
    expect(page.elements[0]).toMatchObject({ index: 1, label: 'Submit', kind: 'Button' });
    expect(page.metrics).toEqual({
      elementCount: 3,
      labelTextChars: expect.any(Number),
      kindCounts: { Button: 2, Edit: 1 },
      truncated: false,
    });
    expect(page.repeatedElements).toEqual([{ label: 'Submit', count: 2 }]);
    expect(page.lastChange).toBeNull();
  });

  it('computes last_change (appeared / disappeared / moved) in code', () => {
    const first = describePage(capture([element(1, 'A', 'Button', 100, 100), element(2, 'B', 'Button', 300, 100)]));
    const second = describePage(
      capture([element(1, 'A', 'Button', 100, 300), element(3, 'C', 'Button', 500, 100)]),
      first,
    );
    expect(second.lastChange).toEqual({ appeared: [3], disappeared: [2], moved: [1] });
  });

  it('marks truncation past the 255 cardinality cap but keeps stable order', () => {
    const many = Array.from({ length: 300 }, (_, i) => element(i + 1, `el${i + 1}`, 'Button'));
    const page = describePage(capture(many));
    expect(page.elements).toHaveLength(255);
    expect(page.elements[0]?.index).toBe(1);
    expect(page.metrics.truncated).toBe(true);
    expect(page.metrics.elementCount).toBe(300);
  });

  it('decision state carries task, element labels, digests and values', () => {
    const page = describePage(capture([element(1, 'OK', 'Button')]));
    const state = pageStateToDecisionState('Log in', page, ['pass123']);
    expect(state.task).toBe('Log in');
    expect(state.values).toEqual(['pass123']);
    expect(state.metrics).toEqual(page.metrics);
    expect(state.last_change).toBeNull();
  });
});

// ─── questions ───

describe('buildRoundQuestions', () => {
  it('omits target on an empty page, value without values, done_change on round 1', () => {
    const empty = buildRoundQuestions({ task: 'T', page: describePage(capture([])) });
    expect(Object.keys(empty).sort()).toEqual(['blocked', 'done', 'error', 'irreversible']);

    const page0 = describePage(capture([]));
    const page = describePage(capture([element(1, 'OK', 'Button')]), page0);
    const first = buildRoundQuestions({ task: 'T', page });
    expect(Object.keys(first).sort()).toEqual(['blocked', 'done', 'error', 'irreversible', 'target']);
    expect(first.target).toMatchObject({ kind: 'choice', options: ['#1 [Button] "OK"'] });

    const withValues = buildRoundQuestions({ task: 'T', page, values: ['a@b.c'], hasPriorRound: true });
    expect(Object.keys(withValues).sort()).toEqual([
      'blocked', 'done', 'done_change', 'error', 'irreversible', 'target', 'value',
    ]);
  });

  it('strict confirmation question is a harder done noul', () => {
    const q = buildStrictConfirmationQuestion('Log in');
    expect(q.done_confirm).toMatchObject({ kind: 'noul' });
    expect(q.done_confirm?.kind === 'noul' && q.done_confirm.instructions).toContain('STRICT');
  });
});

// ─── controller ───

describe('runDecideLoop status contract', () => {
  it('done: high-confidence done terminates immediately', async () => {
    const ports = scriptedPorts([
      { answers: { done: noul(0.93), error: noul(0.01), blocked: noul(0.01), irreversible: noul(0.01) } },
    ]);
    const res = await runDecideLoop(ports, { task: 'Log in' });
    expect(res.status).toBe('done');
    expect(res.actions).toBe(0);
    expect(res.rounds).toBe(1);
  });

  it('acts through the loop and finishes done on a later round', async () => {
    const done = { answers: { done: noul(0.95), error: noul(0.0), blocked: noul(0.0), irreversible: noul(0.0) } };
    const acting = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.05),
        target: choice(OK_TARGET, 0.97),
      },
    };
    const ports = scriptedPorts([acting, acting, done]);
    const res = await runDecideLoop(ports, { task: 'Log in' });
    expect(res.status).toBe('done');
    expect(res.actions).toBe(2);
    expect(ports.actions).toEqual([{ kind: 'click', element: 1 }, { kind: 'click', element: 1 }]);
  });

  it('maps error / blocked nouls to their statuses', async () => {
    const err = { answers: { done: noul(0.1), error: noul(0.9), blocked: noul(0.0), irreversible: noul(0.0), target: choice(OK_TARGET, 0.95) } };
    expect((await runDecideLoop(scriptedPorts([err]), { task: 'T' })).status).toBe('error');

    const blocked = { answers: { done: noul(0.1), error: noul(0.0), blocked: noul(0.9), irreversible: noul(0.0), target: choice(OK_TARGET, 0.95) } };
    expect((await runDecideLoop(scriptedPorts([blocked]), { task: 'T' })).status).toBe('blocked');
  });

  it('ambiguous: low target confidence returns top-3 candidates, never a silent pick', async () => {
    const unsure = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.0),
        target: { kind: 'choice' as const, value: OK_TARGET, distribution: { [OK_TARGET]: 0.4, '#2 [Edit] "Email"': 0.35, other: 0.25 }, confidence: 0.4 },
      },
    };
    const res = await runDecideLoop(scriptedPorts([unsure]), { task: 'T' });
    expect(res.status).toBe('ambiguous');
    expect(res.candidates).toHaveLength(3);
    expect(res.candidates?.[0]?.option).toBe(OK_TARGET);
  });

  it('gray done: strict confirmation re-check gates false-dones', async () => {
    // Round 1: done 0.6 (gray) + action proposed → strict re-ask.
    const gray = {
      answers: {
        done: noul(0.6),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.0),
        target: choice(OK_TARGET, 0.97),
      },
    };
    let asks = 0;
    const ports = scriptedPorts([gray]);
    const baseAsk = ports.ask;
    ports.ask = async (state, questions) => {
      asks++;
      // The strict follow-up rides the same port.
      if (questions && Object.keys(questions).length === 1 && 'done_confirm' in questions) {
        return { answers: { done_confirm: noul(0.55) } }; // strict stays gray
      }
      return baseAsk(state, questions);
    };
    const res = await runDecideLoop(ports, { task: 'T' });
    expect(res.status).toBe('likely_done');
    expect(asks).toBe(2);

    // Strict says NOT done → the loop keeps acting instead of finishing.
    const ports2 = scriptedPorts([gray, gray]);
    ports2.ask = async (state, questions) => {
      if (questions && Object.keys(questions).length === 1 && 'done_confirm' in questions) {
        return { answers: { done_confirm: noul(0.1) } };
      }
      void state;
      return gray;
    };
    const res2 = await runDecideLoop(ports2, { task: 'T', maxActions: 1 });
    expect(res2.status).toBe('max_actions');
    expect(res2.actions).toBe(1);
  });

  it('stuck: repeating the same (action, target) beyond twice stops the loop', async () => {
    const acting = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.0),
        target: choice(OK_TARGET, 0.97),
      },
    };
    const ports = scriptedPorts(Array.from({ length: 5 }, () => acting));
    const res = await runDecideLoop(ports, { task: 'T' });
    expect(res.status).toBe('stuck');
    expect(res.actions).toBe(2);
  });

  it('max_actions: the action cap is enforced by code', async () => {
    const acting = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.0),
        target: choice('#1 [Button] "OK"', 0.97),
      },
    };
    // Alternate targets so the ring detector never fires before the cap.
    const alternating = [
      acting,
      { ...acting, answers: { ...acting.answers, target: choice('#2 [Edit] "Email"', 0.97) } },
    ];
    const ports = scriptedPorts(Array.from({ length: 10 }, (_, i) => alternating[i % 2]));
    const res = await runDecideLoop(ports, { task: 'T', maxActions: 3 });
    expect(res.status).toBe('max_actions');
    expect(res.actions).toBe(3);
  });

  it('irreversible: no gate → needs_confirmation; gate approval executes exactly once', async () => {
    const risky = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.9),
        target: choice(OK_TARGET, 0.97),
      },
    };
    const noGate = await runDecideLoop(scriptedPorts([risky]), { task: 'T' });
    expect(noGate.status).toBe('needs_confirmation');
    expect(noGate.actions).toBe(0);

    const confirm = vi.fn(async () => true);
    const done = { answers: { done: noul(0.95), error: noul(0.0), blocked: noul(0.0), irreversible: noul(0.0) } };
    const gated = await runDecideLoop(scriptedPorts([risky, done], { confirm }), { task: 'T' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(gated.status).toBe('done');
    expect(gated.actions).toBe(1);

    const denied = vi.fn(async () => false);
    const rejected = await runDecideLoop(scriptedPorts([risky], { confirm: denied }), { task: 'T' });
    expect(rejected.status).toBe('needs_confirmation');
  });

  it('act failures: user rejection → needs_confirmation, other failure → error', async () => {
    const acting = {
      answers: {
        done: noul(0.1),
        error: noul(0.0),
        blocked: noul(0.0),
        irreversible: noul(0.0),
        target: choice(OK_TARGET, 0.97),
      },
    };
    const userSaidNo = await runDecideLoop(
      scriptedPorts([acting], { actResults: [{ ok: false, error: 'USER_REJECTED' }] }),
      { task: 'T' },
    );
    expect(userSaidNo.status).toBe('needs_confirmation');

    const failed = await runDecideLoop(
      scriptedPorts([acting], { actResults: [{ ok: false, error: 'IPC_EXCEPTION' }] }),
      { task: 'T' },
    );
    expect(failed.status).toBe('error');
  });

  it('a throwing ask surfaces as status error, never a crash', async () => {
    const ports = scriptedPorts([]);
    ports.ask = async () => {
      throw new Error('no backend');
    };
    const res = await runDecideLoop(ports, { task: 'T' });
    expect(res.status).toBe('error');
    expect(res.reason).toContain('no backend');
  });

  it('parseElementIndex + actionForTarget map choices onto concrete actions', () => {
    expect(parseElementIndex('#12 [Button] "Go"')).toBe(12);
    expect(parseElementIndex('garbage')).toBeUndefined();
    expect(actionForTarget(2, '#2 [Edit] "Email"', 'a@b.c')).toEqual({ kind: 'type', element: 2, text: 'a@b.c' });
    expect(actionForTarget(1, '#1 [Button] "OK"')).toEqual({ kind: 'click', element: 1 });
  });
});

// ─── confirm gates ───

describe('confirm gates', () => {
  it('executor gate: approval denial inside the executor is a false', async () => {
    const gate = createExecutorConfirmGate(async () => ({ ok: false, error: 'USER_REJECTED' }));
    await expect(gate.confirm({ kind: 'click', element: 1 })).resolves.toBe(false);
    const ok = createExecutorConfirmGate(async () => ({ ok: true }));
    await expect(ok.confirm({ kind: 'click', element: 1 })).resolves.toBe(true);
  });

  it('bridge gate: asks first, executes only on allow', async () => {
    const requests: ApprovalRequest[] = [];
    const bridge: ApprovalBridge = {
      requestApproval: async (req) => {
        requests.push(req);
        return { requestId: req.requestId, approved: true, reason: 'user-allow' } as ApprovalResult;
      },
    };
    const exec = vi.fn(async () => ({ ok: true }));
    const gate = createBridgeConfirmGate(bridge, exec);
    await expect(gate.confirm({ kind: 'click', element: 5 })).resolves.toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(requests[0]?.argsPreview).toMatchObject({ kind: 'click', element: 5 });

    const denyBridge: ApprovalBridge = {
      requestApproval: async (req) => ({ requestId: req.requestId, approved: false, reason: 'user-deny' }),
    };
    const gate2 = createBridgeConfirmGate(denyBridge, exec);
    await expect(gate2.confirm({ kind: 'click', element: 5 })).resolves.toBe(false);
    expect(exec).toHaveBeenCalledTimes(1); // not re-executed on deny
  });
});

// ─── verdict bridge ───

describe('assessVerdict', () => {
  const verdict = {
    effect: 'unverifiable' as const,
    verified: { elementChanged: true, newFocusedEntity: null },
  };

  it('clear landing → no escalation; unclear/low → escalate with reason', async () => {
    const landed = { decide: async () => ({ answers: { landed: noul(0.95) } }) };
    expect(await assessVerdict(verdict, landed)).toMatchObject({ escalate: false, pLanded: 0.95 });

    const low = { decide: async () => ({ answers: { landed: noul(0.1) } }) };
    expect(await assessVerdict(verdict, low)).toMatchObject({ escalate: true });

    const gray = { decide: async () => ({ answers: { landed: noul(0.6) } }) };
    expect(await assessVerdict(verdict, gray)).toMatchObject({ escalate: true });
  });

  it('backend failure → null (existing verdict behavior kept)', async () => {
    const broken = { decide: async () => { throw new Error('down'); } };
    expect(await assessVerdict(verdict, broken)).toBeNull();
  });
});

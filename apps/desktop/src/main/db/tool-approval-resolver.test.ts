/**
 * tool-approval-resolver.test.ts — pure decision core for durable approval
 * cards (plan 498).
 *
 * Coverage:
 *  - not_found for unknown ids
 *  - first decision fires continuation + broadcast exactly once
 *  - replayed decision (terminal row) is a no-op
 *  - syncApprovalCard burns the ledger via markConsumed on approved rows
 *  - syncApprovalCard tolerates missing rows
 */
import { describe, expect, it, vi } from 'vitest';

// The resolver module imports electron (broadcast helper) and the structured
// logger (sync error path); mock both so the test stays out of Electron init.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  LogComponent: { DB: 'db' },
}));

import {
  resolveApprovalCard,
  syncApprovalCard,
  type ToolApprovalResolverDeps,
  type ToolApprovalRowLike,
} from './tool-approval-resolver';

function makeRow(overrides: Partial<ToolApprovalRowLike> = {}): ToolApprovalRowLike {
  return {
    id: 'perm-1',
    message_id: 'approval-card-perm-1',
    session_id: 'bot:tester',
    scope_type: 'bot',
    scope_id: 'tester',
    tool_name: 'send_email',
    status: 'pending',
    decision: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ToolApprovalResolverDeps> = {}) {
  const calls = { continuation: [] as Array<[ToolApprovalRowLike, string]>, broadcast: 0 };
  const deps: ToolApprovalResolverDeps = {
    resolve: vi.fn(() => ({ row: makeRow({ status: 'approved', decision: 'allow' }), claimed: true })),
    enqueueContinuation: vi.fn((row, decision) => {
      calls.continuation.push([row, decision]);
    }),
    broadcast: vi.fn(() => {
      calls.broadcast += 1;
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe('resolveApprovalCard', () => {
  it('returns not_found when the row does not exist', () => {
    const { deps } = makeDeps({
      resolve: vi.fn(() => undefined),
    });
    const outcome = resolveApprovalCard(deps, 'missing', 'allow');
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('first decision enqueues continuation and broadcasts once', () => {
    const { deps, calls } = makeDeps();
    const outcome = resolveApprovalCard(deps, 'perm-1', 'always');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.firstDecision).toBe(true);
    expect(calls.continuation).toHaveLength(1);
    expect(calls.continuation[0][1]).toBe('always');
    expect(calls.broadcast).toBe(1);
  });

  it('replayed decision is a no-op (idempotent double-click)', () => {
    const { deps, calls } = makeDeps({
      resolve: vi.fn(() => ({ row: makeRow({ status: 'denied', decision: 'deny' }), claimed: false })),
    });
    const outcome = resolveApprovalCard(deps, 'perm-1', 'allow');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.firstDecision).toBe(false);
    expect(calls.continuation).toHaveLength(0);
    expect(calls.broadcast).toBe(0);
  });

  it('deny decisions also enqueue the continuation (model must learn)', () => {
    const { deps, calls } = makeDeps();
    resolveApprovalCard(deps, 'perm-1', 'deny');
    expect(calls.continuation).toHaveLength(1);
    expect(calls.continuation[0][1]).toBe('deny');
  });
});

describe('syncApprovalCard', () => {
  it('marks approved rows consumed (fast path already executed the call)', () => {
    const markConsumed = vi.fn(() => makeRow({ status: 'consumed', decision: 'allow' }));
    const { deps, calls } = makeDeps({ markConsumed });
    syncApprovalCard({ ...deps, markConsumed }, 'perm-1', 'allow');
    expect(markConsumed).toHaveBeenCalledWith('perm-1');
    expect(calls.broadcast).toBe(1);
    expect(calls.continuation).toHaveLength(0);
  });

  it('broadcasts denied rows without consuming', () => {
    const markConsumed = vi.fn(() => undefined);
    const { deps, calls } = makeDeps({
      resolve: vi.fn(() => ({ row: makeRow({ status: 'denied', decision: 'deny' }), claimed: true })),
      markConsumed,
    });
    syncApprovalCard({ ...deps, markConsumed }, 'perm-1', 'deny');
    expect(markConsumed).not.toHaveBeenCalled();
    expect(calls.broadcast).toBe(1);
  });

  it('swallows store errors (best-effort sync)', () => {
    const { deps } = makeDeps({
      resolve: vi.fn(() => {
        throw new Error('db closed');
      }),
      markConsumed: vi.fn(() => undefined),
    });
    expect(() => syncApprovalCard({ ...deps, markConsumed: vi.fn(() => undefined) }, 'perm-1', 'allow')).not.toThrow();
  });

  it('ignores unknown rows', () => {
    const markConsumed = vi.fn(() => undefined);
    const { deps, calls } = makeDeps({
      resolve: vi.fn(() => undefined),
      markConsumed,
    });
    syncApprovalCard({ ...deps, markConsumed }, 'missing', 'allow');
    expect(markConsumed).not.toHaveBeenCalled();
    expect(calls.broadcast).toBe(0);
  });
});

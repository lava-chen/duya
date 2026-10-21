/**
 * approval.test.ts — plan 454 §6.1 acceptance for approval infra.
 *
 * Coverage:
 *   - InMemoryApprovalBridge: auto-allow / auto-deny / manual policies
 *   - Timeout: requests auto-deny after timeoutMs
 *   - buildArgsPreview: truncation, drop knobs
 *   - getDefaultApprovalBridge / setDefaultApprovalBridge round trip
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  buildArgsPreview,
  getDefaultApprovalBridge,
  InMemoryApprovalBridge,
  setDefaultApprovalBridge,
  __resetDefaultApprovalBridge,
} from '../approval/index.js';

describe('InMemoryApprovalBridge', () => {
  it('auto-allow policy resolves approved', async () => {
    const bridge = new InMemoryApprovalBridge({ policy: 'auto-allow' });
    const r = await bridge.requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 3_000,
    });
    expect(r.approved).toBe(true);
    expect(r.reason).toBe('user-allow');
  });

  it('auto-deny policy resolves denied', async () => {
    const bridge = new InMemoryApprovalBridge({ policy: 'auto-deny' });
    const r = await bridge.requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 3_000,
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBe('user-deny');
  });

  it('manual policy waits for resolve()', async () => {
    const bridge = new InMemoryApprovalBridge({ policy: 'manual', defaultTimeoutMs: 1_000 });
    const req = {
      requestId: 'r1',
      action: 'click' as const,
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 5_000,
    };
    const pending = bridge.requestApproval(req);
    expect(bridge.pendingCount()).toBe(1);
    bridge.resolve('r1', true);
    const r = await pending;
    expect(r.approved).toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('timeout produces denied with reason=timeout', async () => {
    const bridge = new InMemoryApprovalBridge({
      policy: 'manual',
      defaultTimeoutMs: 20,
    });
    const r = await bridge.requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 20,
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  it('records every request in .requests', async () => {
    const bridge = new InMemoryApprovalBridge({ policy: 'auto-allow' });
    await bridge.requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: { x: 1 },
      issuedAt: new Date().toISOString(),
      timeoutMs: 1_000,
    });
    await bridge.requestApproval({
      requestId: 'r2',
      action: 'drag',
      argsPreview: { fromX: 0 },
      issuedAt: new Date().toISOString(),
      timeoutMs: 1_000,
    });
    expect(bridge.requests.length).toBe(2);
    expect(bridge.requests[0]?.requestId).toBe('r1');
    expect(bridge.requests[1]?.action).toBe('drag');
  });

  it('resolve() on unknown id is a no-op', () => {
    const bridge = new InMemoryApprovalBridge({ policy: 'manual' });
    expect(() => bridge.resolve('unknown', true)).not.toThrow();
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('buildArgsPreview', () => {
  it('drops delayMs / timeoutMs knobs', () => {
    const out = buildArgsPreview({ x: 1, delayMs: 10, timeoutMs: 5000 });
    expect(out).toEqual({ x: 1 });
    expect((out as Record<string, unknown>)['delayMs']).toBeUndefined();
  });

  it('truncates long strings to 80 chars', () => {
    const long = 'a'.repeat(200);
    const out = buildArgsPreview({ text: long });
    const truncated = (out as { text: string }).text;
    expect(truncated.endsWith('...')).toBe(true);
    expect(truncated.length).toBe(80);
  });

  it('recurses into arrays', () => {
    const out = buildArgsPreview({ mods: ['ctrl', 'b'.repeat(200)] });
    const arr = (out as { mods: string[] }).mods;
    expect(arr[0]).toBe('ctrl');
    expect((arr[1] ?? '').endsWith('...')).toBe(true);
  });

  it('passes short strings unchanged', () => {
    const out = buildArgsPreview({ text: 'hi' });
    expect(out).toEqual({ text: 'hi' });
  });
});

describe('default bridge round-trip', () => {
  afterEach(() => {
    __resetDefaultApprovalBridge();
  });

  it('default is auto-allow', async () => {
    const r = await getDefaultApprovalBridge().requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 3_000,
    });
    expect(r.approved).toBe(true);
  });

  it('setDefaultApprovalBridge replaces the bridge', async () => {
    const deny = new InMemoryApprovalBridge({ policy: 'auto-deny' });
    setDefaultApprovalBridge(deny);
    const r = await getDefaultApprovalBridge().requestApproval({
      requestId: 'r1',
      action: 'click',
      argsPreview: {},
      issuedAt: new Date().toISOString(),
      timeoutMs: 3_000,
    });
    expect(r.approved).toBe(false);
  });
});
// Regression tests for the `tool_invoke` ↔ permission-chain adapter
// (plan 583, ISS-04).
//
// The P0: the `tool_invoke` dispatcher was wired to the raw
// `hasPermissionsToUseTool` engine, which skipped the per-turn approval
// ledger, the standing `alwaysAllowTools` grants, and the plan-mode
// `gateWriteTool` write barrier. A tool reached through the meta tool could
// therefore write files while the session was in plan mode.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeCanUseToolDecision } from '../toolInvokePermission';

describe('normalizeCanUseToolDecision', () => {
  it('maps boolean true to allow', () => {
    expect(normalizeCanUseToolDecision(true)).toEqual({ behavior: 'allow' });
  });

  it('maps boolean false to deny', () => {
    expect(normalizeCanUseToolDecision(false)).toEqual({ behavior: 'deny' });
  });

  it('passes an explicit allow through', () => {
    expect(normalizeCanUseToolDecision({ allowed: true, behavior: 'allow' })).toEqual({
      behavior: 'allow',
    });
  });

  it('preserves deny and its reason so the dispatcher can surface it', () => {
    expect(
      normalizeCanUseToolDecision({
        allowed: false,
        behavior: 'deny',
        message: 'plan mode blocks writes outside the plan file',
      }),
    ).toEqual({ behavior: 'deny', message: 'plan mode blocks writes outside the plan file' });
  });

  it('preserves ask so the dispatcher can request interactive approval', () => {
    // `ask` must NOT collapse to allow: the dispatcher handles it by calling
    // `context.requestPermission`, and anything else would execute silently.
    expect(normalizeCanUseToolDecision({ allowed: true, behavior: 'ask' })).toEqual({
      behavior: 'ask',
    });
  });

  it('omits the message key entirely when there is no reason', () => {
    const result = normalizeCanUseToolDecision({ allowed: false, behavior: 'deny' });
    expect(result).toEqual({ behavior: 'deny' });
    expect('message' in result).toBe(false);
  });

  it('fails closed when behavior is absent', () => {
    // CanUseToolDecision.behavior is optional; an unrecognised shape must
    // never widen access.
    expect(normalizeCanUseToolDecision({ allowed: true })).toEqual({ behavior: 'deny' });
  });
});

describe('DuyaAgent tool_invoke wiring (ISS-04 guard)', () => {
  const agentSource = fs.readFileSync(
    path.resolve(__dirname, '../DuyaAgent.ts'),
    'utf8',
  ) as string;

  it('does not call the raw permission engine inside the tool_invoke checkPermission', () => {
    // Locate the `createToolInvokeDispatcherFromRegistry({ ... })` call and
    // assert its checkPermission routes through the assembled `canUseTool`
    // adapter, not `this.hasPermissionsToUseTool`. This pins the wiring the
    // way a behavioural test cannot, because it lives inside `streamChat`.
    const call = agentSource.indexOf('createToolInvokeDispatcherFromRegistry({');
    expect(call).toBeGreaterThan(-1);

    const window = agentSource.slice(call, call + 2400);
    const checkPermissionAt = window.indexOf('checkPermission:');
    expect(checkPermissionAt).toBeGreaterThan(-1);

    const body = window.slice(checkPermissionAt, checkPermissionAt + 220);
    expect(body).toContain('canUseTool');
    expect(body).not.toContain('this.hasPermissionsToUseTool');
  });
});

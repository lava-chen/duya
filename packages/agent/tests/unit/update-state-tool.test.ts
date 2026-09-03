/**
 * Plan 481 P2.1 — update_state tool unit tests.
 *
 * Matrix coverage: input resolution (target/scope/action combinations),
 * fact clamping, permission matrix (own=allow / shared=ask / invalid=deny),
 * structured errors, and bridge round-trip with an injected test bridge.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_FACT_CHARS,
  normalizeDedupeKey,
  resolveUpdateStateOperation,
  setMemoryTierBridge,
  updateStateTool,
  UpdateStateTool,
  type MemoryTierBridgeResponse,
  type MemoryTierWritePayload,
} from '../../src/tool/UpdateStateTool/index.js';
import { createToolContext } from '../../src/tool/harness.js';

afterEach(() => {
  setMemoryTierBridge(null);
});

function op(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { target: 'memory', scope: 'agent', action: 'write', fact: 'prefers concise answers', ...overrides };
}

describe('resolveUpdateStateOperation', () => {
  it('maps (memory, agent) to the own agent tier', () => {
    const resolved = resolveUpdateStateOperation(op());
    expect(resolved).toMatchObject({ ok: true, tier: 'agent', sharedLayer: false, membership: false });
  });

  it('maps (memory, user) to the shared user tier', () => {
    const resolved = resolveUpdateStateOperation(op({ scope: 'user' }));
    expect(resolved).toMatchObject({ ok: true, tier: 'user', sharedLayer: true });
  });

  it('maps (project, project) to the project tier and requires project', () => {
    const resolved = resolveUpdateStateOperation(op({ target: 'project', scope: 'project', project: 'alpha' }));
    expect(resolved).toMatchObject({ ok: true, tier: 'project', sharedLayer: true, needsProject: true });
  });

  it('rejects (project, project) without a project id', () => {
    const resolved = resolveUpdateStateOperation(op({ target: 'project', scope: 'project' }));
    expect(resolved).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects (project, agent) — always write your own shard', () => {
    const resolved = resolveUpdateStateOperation(op({ target: 'project', scope: 'agent' }));
    expect(resolved).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects (memory, project) scope inversion', () => {
    const resolved = resolveUpdateStateOperation(op({ scope: 'project' }));
    expect(resolved).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects membership actions outside target=project', () => {
    const resolved = resolveUpdateStateOperation(op({ action: 'join' }));
    expect(resolved).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('accepts membership actions under target=project', () => {
    const resolved = resolveUpdateStateOperation(op({ target: 'project', scope: 'project', action: 'join', project: 'alpha' }));
    expect(resolved).toMatchObject({ ok: true, membership: true, sharedLayer: true });
  });

  it('rejects write without fact', () => {
    const resolved = resolveUpdateStateOperation(op({ fact: undefined }));
    expect(resolved).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects invalid enum values', () => {
    expect(resolveUpdateStateOperation(op({ target: 'session' })).ok).toBe(false);
    expect(resolveUpdateStateOperation(op({ action: 'sync' })).ok).toBe(false);
  });

  it('normalizes the dedupe key (trim + lowercase + collapse whitespace)', () => {
    expect(normalizeDedupeKey('  Prefers   CONCISE\n  answers ')).toBe('prefers concise answers');
    const resolved = resolveUpdateStateOperation(op({ fact: '  Likes Rust  ' }));
    expect(resolved.ok && resolved.dedupeKey).toBe('likes rust');
  });
});

describe('UpdateStateTool.checkPermissions', () => {
  const tool = new UpdateStateTool();
  const { toolContext } = createToolContext();

  it('allows own-tier writes without confirmation', () => {
    const perm = tool.checkPermissions(op(), toolContext);
    expect(perm.allowed).toBe(true);
    expect(perm.requiresUserConfirmation).toBeUndefined();
  });

  it('requires confirmation for user-tier writes', () => {
    const perm = tool.checkPermissions(op({ scope: 'user' }), toolContext);
    expect(perm.allowed).toBe(true);
    expect(perm.requiresUserConfirmation).toBe(true);
  });

  it('requires confirmation for project-tier writes', () => {
    const perm = tool.checkPermissions(op({ target: 'project', scope: 'project', project: 'alpha' }), toolContext);
    expect(perm.allowed).toBe(true);
    expect(perm.requiresUserConfirmation).toBe(true);
  });

  it('requires confirmation for membership changes', () => {
    const perm = tool.checkPermissions(op({ target: 'project', scope: 'project', action: 'leave', project: 'alpha' }), toolContext);
    expect(perm.allowed).toBe(true);
    expect(perm.requiresUserConfirmation).toBe(true);
  });

  it('denies invalid combinations', () => {
    const perm = tool.checkPermissions(op({ target: 'project', scope: 'agent' }), toolContext);
    expect(perm.allowed).toBe(false);
  });
});

describe('UpdateStateTool.execute', () => {
  it('clamps facts longer than the cap before bridging', async () => {
    let captured: MemoryTierWritePayload | undefined;
    setMemoryTierBridge(async (payload) => {
      captured = payload;
      return { success: true, result: { outcome: 'inserted' } };
    });

    const longFact = 'x'.repeat(MAX_FACT_CHARS + 100);
    const result = await updateStateTool.execute(
      op({ fact: longFact }),
      '/tmp',
      createToolContext({ agentProfileId: 'alpha' }).toolUseContext,
    );

    expect(result.error).toBeUndefined();
    expect(captured?.fact).toHaveLength(MAX_FACT_CHARS);
  });

  it('returns a structured NO_IDENTITY error without an agent profile', async () => {
    const result = await updateStateTool.execute(op(), '/tmp', createToolContext().toolUseContext);
    expect(result.error).toBe(true);
    expect(result.result).toContain('NO_IDENTITY');
  });

  it('returns NOT_IMPLEMENTED for membership actions without bridging', async () => {
    let bridgeCalled = false;
    setMemoryTierBridge(async () => {
      bridgeCalled = true;
      return { success: true };
    });

    const ctx = createToolContext({ agentProfileId: 'alpha' });
    const result = await updateStateTool.execute(
      op({ target: 'project', scope: 'project', action: 'join', project: 'alpha' }),
      '/tmp',
      ctx.toolUseContext,
    );

    expect(result.error).toBe(true);
    expect(result.result).toContain('NOT_IMPLEMENTED');
    expect(bridgeCalled).toBe(false);
  });

  it('returns NO_BRIDGE when no bridge and no ipcRequest are available', async () => {
    const ctx = createToolContext({ agentProfileId: 'alpha' });
    const result = await updateStateTool.execute(op(), '/tmp', ctx.toolUseContext);

    expect(result.error).toBe(true);
    expect(result.result).toContain('NO_BRIDGE');
  });

  it('round-trips through the injected bridge and reports the outcome', async () => {
    const calls: MemoryTierWritePayload[] = [];
    setMemoryTierBridge(async (payload): Promise<MemoryTierBridgeResponse> => {
      calls.push(payload);
      return { success: true, result: { outcome: 'inserted', filePath: 'agents/alpha/memory/x.md' } };
    });

    const ctx = createToolContext({ agentProfileId: 'alpha' });
    const result = await updateStateTool.execute(
      op({ target: 'project', scope: 'project', project: 'web', kind: 'profile' }),
      '/tmp',
      ctx.toolUseContext,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actorAgentId: 'alpha',
      tier: 'project',
      action: 'write',
      project: 'web',
      kind: 'profile',
    });
    expect(result.result).toContain('"outcome":"inserted"');
  });

  it('propagates bridge errors as structured tool errors', async () => {
    setMemoryTierBridge(async () => ({
      success: false,
      error: { code: 'STORE_CLOSED', message: 'memory-state db unavailable' },
    }));

    const ctx = createToolContext({ agentProfileId: 'alpha' });
    const result = await updateStateTool.execute(op({ action: 'forget' }), '/tmp', ctx.toolUseContext);

    expect(result.error).toBe(true);
    expect(result.result).toContain('STORE_CLOSED');
  });

  it('rejects invalid input with a structured error before touching the bridge', async () => {
    let bridgeCalled = false;
    setMemoryTierBridge(async () => {
      bridgeCalled = true;
      return { success: true };
    });

    const ctx = createToolContext({ agentProfileId: 'alpha' });
    const result = await updateStateTool.execute(op({ scope: 'project' }), '/tmp', ctx.toolUseContext);

    expect(result.error).toBe(true);
    expect(result.result).toContain('INVALID_INPUT');
    expect(bridgeCalled).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolUseContext } from '../src/contracts/tool.js';
import {
  MAX_FACT_CHARS,
} from '../src/UpdateStateTool/constants.js';
import {
  normalizeDedupeKey,
  UpdateStateTool,
  resolveUpdateStateOperation,
} from '../src/UpdateStateTool/UpdateStateTool.js';
import type {
  BotIdentityPatchPayload,
  MemoryTierBridgeResponse,
  MemoryTierWritePayload,
  UpdateStateContext,
  UpdateStatePort,
} from '../src/UpdateStateTool/ports.js';

const writes = vi.fn<UpdateStatePort['writeMemory']>();
const identities = vi.fn<UpdateStatePort['updateIdentity']>();
const tool = new UpdateStateTool({ writeMemory: writes, updateIdentity: identities });

function op(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { target: 'memory', scope: 'agent', action: 'write', fact: 'prefers concise answers', ...overrides };
}

function context(agentProfileId: string | null = 'alpha'): UpdateStateContext {
  return {
    toolUseId: 'test',
    abortController: new AbortController(),
    getAppState: (() => ({})) as ToolUseContext['getAppState'],
    setAppState: () => {},
    options: { tools: [], commands: [], mainLoopModel: 'test', mcpClients: [], agentProfileId },
  } as UpdateStateContext;
}

function response(result?: unknown): MemoryTierBridgeResponse {
  return { success: true, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.mockResolvedValue(response({ outcome: 'inserted' }));
  identities.mockResolvedValue(response({ updated: true }));
});

describe('resolveUpdateStateOperation', () => {
  it('maps memory and project scopes to their own tiers', () => {
    expect(resolveUpdateStateOperation(op())).toMatchObject({
      ok: true, tier: 'agent', sharedLayer: false, membership: false,
    });
    expect(resolveUpdateStateOperation(op({ scope: 'user' }))).toMatchObject({
      ok: true, tier: 'user', sharedLayer: true,
    });
    expect(resolveUpdateStateOperation(op({ target: 'project', scope: 'project', project: 'alpha' }))).toMatchObject({
      ok: true, tier: 'project', needsProject: true, sharedLayer: true,
    });
  });

  it('rejects invalid combinations, missing projects, and malformed facts', () => {
    for (const input of [
      op({ target: 'project', scope: 'project' }),
      op({ target: 'project', scope: 'agent', project: 'alpha' }),
      op({ scope: 'project' }),
      op({ target: 'memory', action: 'join' }),
      op({ fact: '  ' }),
      op({ action: 'unknown' }),
    ]) {
      expect(resolveUpdateStateOperation(input).ok).toBe(false);
    }
  });

  it('normalizes and clamps memory facts', () => {
    expect(normalizeDedupeKey('  Prefers   CONCISE\n answers ')).toBe('prefers concise answers');
    const resolved = resolveUpdateStateOperation(op({ fact: ` ${'x'.repeat(MAX_FACT_CHARS + 50)} ` }));
    expect(resolved.ok && resolved.fact).toHaveLength(MAX_FACT_CHARS);
  });

  it('resolves profile and avatar updates as self-scoped identity operations', () => {
    const profile = resolveUpdateStateOperation({ target: 'profile', action: 'set', name: 'Night Ops', description: 'Builds safely' });
    expect(profile).toMatchObject({ ok: true, identity: { subaction: 'profile.set', name: 'Night Ops', description: 'Builds safely' } });
    const avatar = resolveUpdateStateOperation({ target: 'avatar', action: 'set', avatarColor: 'violet' });
    expect(avatar).toMatchObject({ ok: true, identity: { subaction: 'avatar.set', avatarColor: 'violet' } });
    expect(resolveUpdateStateOperation({ target: 'avatar', action: 'clear' })).toMatchObject({
      ok: true, identity: { subaction: 'avatar.clear' },
    });
    expect(resolveUpdateStateOperation({ target: 'profile', action: 'set' }).ok).toBe(false);
  });
});

describe('UpdateStateTool permissions', () => {
  const permissionContext = {} as ToolContext;

  it('allows own-tier and identity writes, asks for shared tiers, and denies invalid operations', () => {
    expect(tool.checkPermissions(op(), permissionContext)).toMatchObject({ allowed: true });
    expect(tool.checkPermissions(op({ scope: 'user' }), permissionContext)).toMatchObject({
      allowed: true, requiresUserConfirmation: true,
    });
    expect(tool.checkPermissions(op({ target: 'project', scope: 'project', project: 'alpha' }), permissionContext)).toMatchObject({
      allowed: true, requiresUserConfirmation: true,
    });
    expect(tool.checkPermissions({ target: 'profile', action: 'set', name: 'Name' }, permissionContext)).toMatchObject({
      allowed: true,
    });
    expect(tool.checkPermissions(op({ target: 'project', scope: 'agent' }), permissionContext)).toMatchObject({
      allowed: false,
    });
  });
});

describe('UpdateStateTool execution', () => {
  it('clamps facts and sends the resolved memory payload to the injected port', async () => {
    let captured: MemoryTierWritePayload | undefined;
    writes.mockImplementation(async (payload) => {
      captured = payload;
      return response({ outcome: 'inserted' });
    });
    const result = await tool.execute(op({ fact: 'x'.repeat(MAX_FACT_CHARS + 100) }), undefined, context());
    expect(result.error).toBeUndefined();
    expect(captured?.fact).toHaveLength(MAX_FACT_CHARS);
    expect(captured).toMatchObject({ actorAgentId: 'alpha', tier: 'agent', action: 'write', kind: 'note' });
    expect(JSON.parse(result.result)).toMatchObject({ success: true, tier: 'agent', outcome: { outcome: 'inserted' } });
  });

  it('returns NO_IDENTITY before bridging when no bot profile is bound', async () => {
    const result = await tool.execute(op(), undefined, context(null));
    expect(result.error).toBe(true);
    expect(result.result).toContain('NO_IDENTITY');
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns NOT_IMPLEMENTED for project membership actions', async () => {
    const result = await tool.execute(op({ target: 'project', scope: 'project', project: 'alpha', action: 'join' }), undefined, context());
    expect(result.error).toBe(true);
    expect(result.result).toContain('NOT_IMPLEMENTED');
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns NO_BRIDGE when a Host port reports no connected RPC', async () => {
    writes.mockResolvedValueOnce(null);
    const result = await tool.execute(op(), undefined, context());
    expect(result.error).toBe(true);
    expect(result.result).toContain('NO_BRIDGE');
  });

  it('preserves structured bridge errors and thrown bridge failures', async () => {
    writes.mockResolvedValueOnce({ success: false, error: { code: 'STORE_CLOSED', message: 'closed' } });
    const rejected = await tool.execute(op(), undefined, context());
    expect(rejected.error).toBe(true);
    expect(rejected.result).toContain('STORE_CLOSED');

    writes.mockRejectedValueOnce(new Error('RPC failed'));
    const thrown = await tool.execute(op(), undefined, context());
    expect(thrown.error).toBe(true);
    expect(thrown.result).toContain('BRIDGE_ERROR');
    expect(thrown.result).toContain('RPC failed');
  });

  it('routes profile and avatar updates with the calling identity', async () => {
    const sent: BotIdentityPatchPayload[] = [];
    identities.mockImplementation(async (payload) => {
      sent.push(payload);
      return response({ name: payload.name });
    });
    const profile = await tool.execute({ target: 'profile', action: 'set', name: 'Night Ops' }, undefined, context());
    const avatar = await tool.execute({ target: 'avatar', action: 'clear' }, undefined, context());
    expect(profile.error).toBeUndefined();
    expect(avatar.error).toBeUndefined();
    expect(sent).toEqual([
      { actorAgentId: 'alpha', subaction: 'profile.set', name: 'Night Ops' },
      { actorAgentId: 'alpha', subaction: 'avatar.clear' },
    ]);
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns NO_BRIDGE and structured failure for identity RPC responses', async () => {
    identities.mockResolvedValueOnce(null);
    const unavailable = await tool.execute({ target: 'profile', action: 'set', name: 'Name' }, undefined, context());
    expect(JSON.parse(unavailable.result)).toMatchObject({ success: false, error: { code: 'NO_BRIDGE' } });

    identities.mockResolvedValueOnce({ success: false, error: { code: 'IDENTITY_MISMATCH', message: 'mismatch' } });
    const mismatch = await tool.execute({ target: 'profile', action: 'set', name: 'Name' }, undefined, context());
    expect(mismatch.error).toBe(true);
    expect(JSON.parse(mismatch.result)).toMatchObject({ success: false, error: { code: 'IDENTITY_MISMATCH' } });
  });
});

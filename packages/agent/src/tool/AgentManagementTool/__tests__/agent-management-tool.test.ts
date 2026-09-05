/**
 * Plan 492 P4 — CreateAgent / UpdateAgent tool tests.
 *
 * Validation, grok-parity result strings, and the db-client boundary
 * (mocked: the real module wires process.send IPC at import time, which
 * crashes under the vitest pool).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(async () => ({ id: 'researcher', name: 'Researcher' })),
  agentUpdate: vi.fn(async () => ({ id: 'researcher', name: 'Researcher' })),
}));

vi.mock('../../../ipc/db-client.js', () => ({
  configDb: {
    agentCreate: mocks.agentCreate,
    agentUpdate: mocks.agentUpdate,
  },
}));

import { createAgentTool, updateAgentTool } from '../AgentManagementTool.js';

type ExecResult = { id: string; name: string; result: string; error?: boolean };

describe('create_agent tool', () => {
  beforeEach(() => {
    mocks.agentCreate.mockClear();
    mocks.agentCreate.mockImplementation(async () => ({ id: 'researcher', name: 'Researcher' }));
  });

  it('creates an agent and returns the id with SendToAgent guidance', async () => {
    const res = (await createAgentTool.execute({
      name: 'Researcher',
      description: 'Deep-dive research teammate',
    })) as ExecResult;

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Created agent "Researcher"');
    expect(res.result).toContain('id: researcher');
    expect(res.result).toContain('send_to_agent');
    expect(mocks.agentCreate).toHaveBeenCalledWith({
      name: 'Researcher',
      description: 'Deep-dive research teammate',
    });
  });

  it('requires a name (grok validation)', async () => {
    const res = (await createAgentTool.execute({})) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('name is required');
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name', async () => {
    const res = (await createAgentTool.execute({ name: '   ' })) as ExecResult;
    expect(res.error).toBe(true);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('reports a main-process failure with the error text', async () => {
    mocks.agentCreate.mockImplementation(async () => {
      throw new Error('config store unavailable');
    });
    const res = (await createAgentTool.execute({ name: 'X' })) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('Failed to create agent');
    expect(res.result).toContain('config store unavailable');
  });
});

describe('update_agent tool', () => {
  beforeEach(() => {
    mocks.agentUpdate.mockClear();
    mocks.agentUpdate.mockImplementation(async () => ({ id: 'researcher', name: 'Researcher' }));
  });

  it('patches name and description only', async () => {
    const res = (await updateAgentTool.execute({
      agentId: 'researcher',
      name: 'Scout',
      description: 'New persona',
    })) as ExecResult;

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Updated agent "Researcher" (id: researcher)');
    expect(mocks.agentUpdate).toHaveBeenCalledWith({
      agentId: 'researcher',
      name: 'Scout',
      description: 'New persona',
    });
  });

  it('treats an empty patch as a teaching message, not an error (grok parity)', async () => {
    const res = (await updateAgentTool.execute({ agentId: 'researcher' })) as ExecResult;
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Nothing to update');
    expect(mocks.agentUpdate).not.toHaveBeenCalled();
  });

  it('requires agentId', async () => {
    const res = (await updateAgentTool.execute({ name: 'X' })) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('agentId is required');
  });

  it('turns a not-found error into grok guidance without the error flag', async () => {
    mocks.agentUpdate.mockImplementation(async () => {
      throw new Error("agent 'ghost' not found");
    });
    const res = (await updateAgentTool.execute({
      agentId: 'ghost',
      name: 'X',
    })) as ExecResult;
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('No agent found with id ghost');
    expect(res.result).toContain('teammates list');
  });

  it('reports unrelated failures with the error flag', async () => {
    mocks.agentUpdate.mockImplementation(async () => {
      throw new Error('config store unavailable');
    });
    const res = (await updateAgentTool.execute({
      agentId: 'researcher',
      name: 'X',
    })) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('Failed to update agent');
  });
});

describe('tool registration surface', () => {
  it('exposes grok-parity wire names and schemas', () => {
    expect(createAgentTool.name).toBe('create_agent');
    expect(updateAgentTool.name).toBe('update_agent');
    expect((createAgentTool.input_schema as { required: string[] }).required).toEqual(['name']);
    expect((updateAgentTool.input_schema as { required: string[] }).required).toEqual(['agentId']);
    expect(createAgentTool.description).toContain('send_to_agent');
    expect(updateAgentTool.description).toContain('no way to clear or delete');
  });
});

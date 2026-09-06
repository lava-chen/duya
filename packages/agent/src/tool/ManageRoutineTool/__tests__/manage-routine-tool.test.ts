/**
 * Plan 476 P2.3b — manage_routine tool tests.
 *
 * Validation, ownership enforcement (bot can only manage its own routines,
 * derived from its own `bot:<agentId>` session id), and the db-client
 * boundary (mocked: the real module wires process.send IPC at import time,
 * which crashes under the vitest pool).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCrons: vi.fn(async () => [] as Array<Record<string, unknown>>),
  createCron: vi.fn(async () => ({ id: 'morning-digest', name: 'Morning digest' })),
  updateCron: vi.fn(async () => ({ id: 'morning-digest', name: 'Morning digest' })),
  deleteCron: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../ipc/db-client.js', () => ({
  automationDb: {
    listCrons: mocks.listCrons,
    createCron: mocks.createCron,
    updateCron: mocks.updateCron,
    deleteCron: mocks.deleteCron,
  },
}));

import { manageRoutineTool, MAX_ROUTINES_PER_BOT } from '../ManageRoutineTool.js';

type ExecResult = { id: string; name: string; result: string; error?: boolean };

const BOT_CTX = { options: { sessionId: 'bot:news-bot' } } as never;
const OWNED_JOB = {
  id: 'morning-digest',
  name: 'Morning digest',
  agent: 'news-bot',
  enabled: true,
  schedule: { kind: 'cron', expr: '32 8 * * 1-5' },
  lastRunAt: 1_700_000_000_000,
  lastError: null,
};

describe('manage_routine — ownership gate', () => {
  it('refuses a non-bot session (no bot:<agentId> session id)', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'create', name: 'X', prompt: 'Y', schedule: { kind: 'cron', expr: '0 7 * * *' } },
      undefined,
      { options: { sessionId: 'plain-session' } } as never,
    )) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('routines belong to bots');
    expect(mocks.createCron).not.toHaveBeenCalled();
  });

  it('refuses missing session context entirely', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'list' },
      undefined,
      undefined,
    )) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('routines belong to bots');
  });
});

describe('manage_routine — create', () => {
  beforeEach(() => {
    mocks.createCron.mockClear();
    mocks.createCron.mockImplementation(async () => ({ id: 'morning-digest', name: 'Morning digest' }));
    mocks.listCrons.mockClear();
    mocks.listCrons.mockImplementation(async () => []);
  });

  it('creates with the calling bot bound and enabled', async () => {
    const res = (await manageRoutineTool.execute(
      {
        action: 'create',
        name: 'Morning digest',
        prompt: 'Summarize overnight news and send it.',
        schedule: { kind: 'cron', expr: '32 8 * * 1-5' },
      },
      undefined,
      BOT_CTX,
    )) as ExecResult;

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Created routine "Morning digest" (id morning-digest)');
    expect(mocks.createCron).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'news-bot', enabled: true }),
    );
  });

  it('requires name, prompt, and schedule', async () => {
    for (const bad of [
      { action: 'create', prompt: 'p', schedule: { kind: 'cron', expr: '0 7 * * *' } },
      { action: 'create', name: 'N', schedule: { kind: 'cron', expr: '0 7 * * *' } },
      { action: 'create', name: 'N', prompt: 'p' },
    ]) {
      const res = (await manageRoutineTool.execute(bad, undefined, BOT_CTX)) as ExecResult;
      expect(res.error).toBe(true);
    }
    expect(mocks.createCron).not.toHaveBeenCalled();
  });

  it('validates the schedule shape per kind', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'create', name: 'N', prompt: 'p', schedule: { kind: 'cron' } },
      undefined,
      BOT_CTX,
    )) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('schedule.expr');
    expect(mocks.createCron).not.toHaveBeenCalled();
  });

  it('enforces the per-bot routine cap', async () => {
    const owned = Array.from({ length: MAX_ROUTINES_PER_BOT }, (_, i) => ({
      ...OWNED_JOB,
      id: `routine-${i}`,
    }));
    mocks.listCrons.mockImplementation(async () => owned);
    const res = (await manageRoutineTool.execute(
      { action: 'create', name: 'N', prompt: 'p', schedule: { kind: 'cron', expr: '0 7 * * *' } },
      undefined,
      BOT_CTX,
    )) as ExecResult;
    expect(res.error).toBe(true);
    expect(res.result).toContain('limit');
    expect(mocks.createCron).not.toHaveBeenCalled();
  });
});

describe('manage_routine — update / pause / resume / delete', () => {
  beforeEach(() => {
    mocks.updateCron.mockClear();
    mocks.deleteCron.mockClear();
    mocks.listCrons.mockClear();
    mocks.listCrons.mockImplementation(async () => [OWNED_JOB, { ...OWNED_JOB, id: 'other-bot-job', name: 'Foreign', agent: 'someone-else' }]);
  });

  it('updates an owned routine', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'update', id: 'morning-digest', prompt: 'New instruction.' },
      undefined,
      BOT_CTX,
    )) as ExecResult;
    expect(res.error).toBeUndefined();
    expect(mocks.updateCron).toHaveBeenCalledWith('morning-digest', { prompt: 'New instruction.' });
  });

  it('refuses to touch a routine owned by another bot', async () => {
    for (const action of ['update', 'pause', 'resume', 'delete'] as const) {
      const res = (await manageRoutineTool.execute(
        { action, id: 'other-bot-job' },
        undefined,
        BOT_CTX,
      )) as ExecResult;
      expect(res.result).toContain('belongs to you');
      expect(mocks.updateCron).not.toHaveBeenCalled();
      expect(mocks.deleteCron).not.toHaveBeenCalled();
    }
  });

  it('pause/resume map to the enabled flag', async () => {
    await manageRoutineTool.execute({ action: 'pause', id: 'morning-digest' }, undefined, BOT_CTX);
    expect(mocks.updateCron).toHaveBeenLastCalledWith('morning-digest', { enabled: false });
    await manageRoutineTool.execute({ action: 'resume', id: 'morning-digest' }, undefined, BOT_CTX);
    expect(mocks.updateCron).toHaveBeenLastCalledWith('morning-digest', { enabled: true });
  });

  it('deletes an owned routine', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'delete', id: 'morning-digest' },
      undefined,
      BOT_CTX,
    )) as ExecResult;
    expect(res.error).toBeUndefined();
    expect(mocks.deleteCron).toHaveBeenCalledWith('morning-digest');
  });

  it('treats an empty update patch as a teaching message', async () => {
    const res = (await manageRoutineTool.execute(
      { action: 'update', id: 'morning-digest' },
      undefined,
      BOT_CTX,
    )) as ExecResult;
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Nothing to update');
    expect(mocks.updateCron).not.toHaveBeenCalled();
  });
});

describe('manage_routine — list', () => {
  it('renders only the calling bot\'s routines with ids', async () => {
    mocks.listCrons.mockImplementation(async () => [
      OWNED_JOB,
      { ...OWNED_JOB, id: 'other-bot-job', name: 'Foreign', agent: undefined },
    ]);
    const res = (await manageRoutineTool.execute({ action: 'list' }, undefined, BOT_CTX)) as ExecResult;
    expect(res.result).toContain('Your routines:');
    expect(res.result).toContain('morning-digest');
    expect(res.result).toContain('cron "32 8 * * 1-5"');
    expect(res.result).not.toContain('Foreign');
  });

  it('reports an empty inventory', async () => {
    mocks.listCrons.mockImplementation(async () => []);
    const res = (await manageRoutineTool.execute({ action: 'list' }, undefined, BOT_CTX)) as ExecResult;
    expect(res.result).toContain('no routines yet');
  });
});

describe('tool registration surface', () => {
  it('exposes the wire name and action enum', () => {
    expect(manageRoutineTool.name).toBe('manage_routine');
    expect((manageRoutineTool.input_schema as { properties: Record<string, unknown> }).properties.action).toBeDefined();
    expect(manageRoutineTool.description).toContain('[routine]');
    expect(manageRoutineTool.description).toContain('SendMessage');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageRoutineTool, MAX_ROUTINES_PER_BOT } from '../src/ManageRoutineTool/ManageRoutineTool.js';
import type {
  ManageRoutinePort,
  RoutineCreateInput,
  RoutineMarkerAction,
  RoutineRecord,
  RoutineUpdateInput,
} from '../src/ManageRoutineTool/ports.js';

const ownedRoutine: RoutineRecord = {
  id: 'morning-digest',
  name: 'Morning digest',
  agent: 'news-bot',
  enabled: true,
  schedule: { kind: 'cron', expr: '32 8 * * 1-5' },
  lastRunAt: 1_700_000_000_000,
  lastError: null,
};

const effects = {
  listRoutines: vi.fn(async (): Promise<readonly RoutineRecord[]> => []),
  createRoutine: vi.fn(async (_input: RoutineCreateInput): Promise<RoutineRecord> => ({ id: 'morning-digest', name: 'Morning digest' })),
  updateRoutine: vi.fn(async (_id: string, _input: RoutineUpdateInput): Promise<RoutineRecord> => ({ id: 'morning-digest', name: 'Morning digest' })),
  deleteRoutine: vi.fn(async (_id: string) => {}),
  appendRoutineMarker: vi.fn(async (_sessionId: string, _action: RoutineMarkerAction, _routineId: string, _name: string) => {}),
};

const port: ManageRoutinePort = {
  resolveSessionId(context) {
    if (!context || typeof context !== 'object') return '';
    const options = (context as { options?: { sessionId?: unknown } }).options;
    return typeof options?.sessionId === 'string' ? options.sessionId : '';
  },
  listRoutines: () => effects.listRoutines(),
  createRoutine: (input) => effects.createRoutine(input),
  updateRoutine: (id, input) => effects.updateRoutine(id, input),
  deleteRoutine: (id) => effects.deleteRoutine(id),
  appendRoutineMarker: (sessionId, action, routineId, name) => effects.appendRoutineMarker(sessionId, action, routineId, name),
};

const tool = new ManageRoutineTool(port);
const botContext = { toolUseId: 'test', options: { sessionId: 'bot:news-bot' } };

beforeEach(() => {
  vi.clearAllMocks();
  effects.listRoutines.mockResolvedValue([]);
  effects.createRoutine.mockResolvedValue({ id: 'morning-digest', name: 'Morning digest' });
  effects.updateRoutine.mockResolvedValue({ id: 'morning-digest', name: 'Morning digest' });
});

describe('manage_routine ownership and mutation', () => {
  it('refuses a non-bot or missing session', async () => {
    for (const context of [undefined, { toolUseId: 'test', options: { sessionId: 'plain-session' } }]) {
      const result = await tool.execute({ action: 'list' }, undefined, context);
      expect(result.error).toBe(true);
      expect(result.result).toContain('routines belong to bots');
    }
    expect(effects.listRoutines).not.toHaveBeenCalled();
  });

  it('creates with the calling bot bound and enabled', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'Morning digest',
      prompt: 'Summarize overnight news and send it.',
      schedule: { kind: 'cron', expr: '32 8 * * 1-5' },
    }, undefined, botContext);
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Created routine "Morning digest" (id morning-digest)');
    expect(effects.createRoutine).toHaveBeenCalledWith(expect.objectContaining({ agent: 'news-bot', enabled: true }));
    expect(effects.appendRoutineMarker).toHaveBeenCalledWith('bot:news-bot', 'created', 'morning-digest', 'Morning digest');
  });

  it('validates schedule shape and enforces the per-bot limit', async () => {
    const invalid = await tool.execute({ action: 'create', name: 'N', prompt: 'p', schedule: { kind: 'cron' } }, undefined, botContext);
    expect(invalid.error).toBe(true);
    expect(invalid.result).toContain('schedule.expr');
    expect(effects.createRoutine).not.toHaveBeenCalled();

    effects.listRoutines.mockResolvedValue(Array.from({ length: MAX_ROUTINES_PER_BOT }, (_, index) => ({
      ...ownedRoutine,
      id: `routine-${index}`,
    })));
    const limited = await tool.execute({ action: 'create', name: 'N', prompt: 'p', schedule: { kind: 'cron', expr: '0 7 * * *' } }, undefined, botContext);
    expect(limited.error).toBe(true);
    expect(limited.result).toContain('limit');
    expect(effects.createRoutine).not.toHaveBeenCalled();
  });

  it('only updates routines owned by the calling bot', async () => {
    effects.listRoutines.mockResolvedValue([
      ownedRoutine,
      { ...ownedRoutine, id: 'foreign', name: 'Foreign', agent: 'someone-else' },
    ]);
    const update = await tool.execute({ action: 'update', id: 'morning-digest', prompt: 'New instruction.' }, undefined, botContext);
    expect(update.error).toBeUndefined();
    expect(effects.updateRoutine).toHaveBeenCalledWith('morning-digest', { prompt: 'New instruction.' });

    for (const action of ['update', 'pause', 'resume', 'delete'] as const) {
      const result = await tool.execute({ action, id: 'foreign' }, undefined, botContext);
      expect(result.result).toContain('belongs to you');
    }
    expect(effects.deleteRoutine).not.toHaveBeenCalled();
  });

  it('deletes only an owned routine and treats an empty update as guidance', async () => {
    effects.listRoutines.mockResolvedValue([ownedRoutine]);
    const deleted = await tool.execute({ action: 'delete', id: 'morning-digest' }, undefined, botContext);
    expect(deleted.error).toBeUndefined();
    expect(effects.deleteRoutine).toHaveBeenCalledWith('morning-digest');
    expect(effects.appendRoutineMarker).toHaveBeenCalledWith(
      'bot:news-bot', 'deleted', 'morning-digest', 'Morning digest',
    );

    effects.updateRoutine.mockClear();
    const emptyUpdate = await tool.execute({ action: 'update', id: 'morning-digest' }, undefined, botContext);
    expect(emptyUpdate.error).toBeUndefined();
    expect(emptyUpdate.result).toContain('Nothing to update');
    expect(effects.updateRoutine).not.toHaveBeenCalled();
  });

  it('maps pause/resume to enabled, and lists only owned routines', async () => {
    effects.listRoutines.mockResolvedValue([ownedRoutine, { ...ownedRoutine, id: 'foreign', agent: 'other' }]);
    await tool.execute({ action: 'pause', id: 'morning-digest' }, undefined, botContext);
    expect(effects.updateRoutine).toHaveBeenLastCalledWith('morning-digest', { enabled: false });
    await tool.execute({ action: 'resume', id: 'morning-digest' }, undefined, botContext);
    expect(effects.updateRoutine).toHaveBeenLastCalledWith('morning-digest', { enabled: true });

    const listed = await tool.execute({ action: 'list' }, undefined, botContext);
    expect(listed.result).toContain('morning-digest');
    expect(listed.result).toContain('cron "32 8 * * 1-5"');
    expect(listed.result).not.toContain('foreign');
  });

  it('preserves the wire name and self-management guidance', () => {
    expect(tool.name).toBe('manage_routine');
    expect((tool.input_schema as { properties: Record<string, unknown> }).properties.action).toBeDefined();
    expect(tool.description).toContain('[routine]');
    expect(tool.description).toContain('SendMessage');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodoTool, TODO_TOOL_NAME, LEGACY_TODO_WIRE_NAMES } from '../TodoTool.js';
import type { TaskStore, Task } from '../../../session/task-store.js';

// Mock state shared between the vi.mock factory and the test bodies.
// Mirrors the AGENTS.md IPC test pattern (vi.hoisted singleton).
const mocks = vi.hoisted(() => {
  const state: { tasks: Task[] } = { tasks: [] };
  const store: TaskStore = {
    getTask: vi.fn(async (id: string) => state.tasks.find(t => t.id === id) ?? null),
    listTasks: vi.fn(async () => [...state.tasks]),
    createTask: vi.fn(async (task: Omit<Task, 'id'>) => {
      const created: Task = { id: `t${state.tasks.length + 1}`, ...task };
      state.tasks.push(created);
      return created;
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const idx = state.tasks.findIndex(t => t.id === id);
      if (idx === -1) return null;
      state.tasks[idx] = { ...state.tasks[idx], ...updates };
      return state.tasks[idx];
    }),
    deleteTask: vi.fn(async (id: string) => {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter(t => t.id !== id);
      return state.tasks.length !== before;
    }),
    claimTask: vi.fn(async () => ({ success: false, reason: 'task_not_found' as const })),
    blockTask: vi.fn(async () => false),
    getAgentStatuses: vi.fn(async () => []),
    unassignTeammateTasks: vi.fn(async () => ({ unassignedTasks: [], notificationMessage: '' })),
  };
  return { state, store };
});

vi.mock('../../../session/task-store.js', () => ({
  getDatabaseTaskStore: () => mocks.store,
}));

const tool = new TodoTool();

function ctx(sessionId = 's1') {
  return { options: { sessionId } } as Parameters<typeof tool.execute>[2];
}

beforeEach(() => {
  mocks.state.tasks = [];
  vi.clearAllMocks();
});

describe('TodoTool', () => {
  it('exposes the canonical todo wire name', () => {
    expect(TODO_TOOL_NAME).toBe('todo');
    expect(tool.toTool().name).toBe('todo');
  });

  it('tracks the legacy wire names accepted during projection', () => {
    expect(LEGACY_TODO_WIRE_NAMES).toEqual(['task', 'Task']);
  });

  it('replace builds the full list (merge=false)', async () => {
    const res = await tool.execute(
      {
        merge: false,
        todos: [
          { id: 'a', content: 'First step' },
          { id: 'b', content: 'Second step', status: 'in_progress' },
        ],
      },
      undefined,
      ctx(),
    );
    expect(res.error).toBeFalsy();
    const parsed = JSON.parse(res.result) as { todos: { id: string; content: string; status: string }[]; summary_for_prompt: string };
    expect(parsed.todos).toHaveLength(2);
    expect(parsed.todos[0]).toMatchObject({ content: 'First step', status: 'pending' });
    expect(parsed.todos[1]).toMatchObject({ content: 'Second step', status: 'in_progress' });
    expect(parsed.summary_for_prompt).toContain('- [pending]');
  });

  it('merge updates an existing item by status without dropping content', async () => {
    mocks.state.tasks = [{
      id: 'a', subject: 'Keep me', description: '', status: 'pending',
      blocks: [], blockedBy: [],
    }];
    const res = await tool.execute(
      { todos: [{ id: 'a', status: 'completed' }] },
      undefined,
      ctx(),
    );
    expect(res.error).toBeFalsy();
    const parsed = JSON.parse(res.result) as { todos: { id: string; content: string; status: string }[] };
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0]).toMatchObject({ id: 'a', content: 'Keep me', status: 'completed' });
  });

  it('merge adds a new item when the id does not exist', async () => {
    const res = await tool.execute(
      { todos: [{ id: 'new', content: 'Brand new' }] },
      undefined,
      ctx(),
    );
    expect(res.error).toBeFalsy();
    const parsed = JSON.parse(res.result) as { todos: { content: string }[] };
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0].content).toBe('Brand new');
  });

  it('rejects duplicate ids', async () => {
    const res = await tool.execute(
      { todos: [{ id: 'a' }, { id: 'a' }] },
      undefined,
      ctx(),
    );
    expect(res.error).toBe(true);
    expect(res.result).toContain('unique id');
  });

  it('returns the empty-list summary when no tasks are tracked', async () => {
    const res = await tool.execute({ todos: [] }, undefined, ctx());
    expect(res.error).toBeFalsy();
    const parsed = JSON.parse(res.result) as { summary_for_prompt: string; todos: unknown[] };
    expect(parsed.summary_for_prompt).toBe('No tasks currently tracked.');
    expect(parsed.todos).toHaveLength(0);
  });

  it('errors without a session context', async () => {
    const res = await tool.execute({ todos: [] }, undefined, undefined);
    expect(res.error).toBe(true);
  });
});
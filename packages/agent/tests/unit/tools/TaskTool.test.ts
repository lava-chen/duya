/**
 * TaskTool Unit Tests
 * Tests the unified task management tool without real SQLite database.
 * Mocks getDatabaseTaskStore to use an in-memory implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskTool, taskTool } from '../../../src/tool/TaskTool/TaskTool.js';
import type { Task, TaskStatus } from '../../../src/session/task-store.js';

// ── In-Memory Task Store for Testing ──

class InMemoryTaskStore {
  private tasks = new Map<string, Task>();
  private nextId = 1;

  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) || null;
  }

  async listTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const id = String(this.nextId++);
    const created: Task = { id, ...task };
    this.tasks.set(id, created);
    return created;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    this.tasks.set(taskId, updated);
    return updated;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  async claimTask(taskId: string, owner: string) {
    const task = await this.getTask(taskId);
    if (!task) return { success: false as const, reason: 'task_not_found' as const };
    if (task.owner && task.owner !== owner) return { success: false as const, reason: 'already_claimed' as const };
    if (task.status === 'completed') return { success: false as const, reason: 'already_resolved' as const };
    await this.updateTask(taskId, { owner, status: 'in_progress' });
    return { success: true as const, task: this.tasks.get(taskId)! };
  }

  async blockTask(fromTaskId: string, toTaskId: string): Promise<boolean> {
    const fromTask = await this.getTask(fromTaskId);
    const toTask = await this.getTask(toTaskId);
    if (!fromTask || !toTask) return false;
    if (!fromTask.blocks.includes(toTaskId)) {
      await this.updateTask(fromTaskId, { blocks: [...fromTask.blocks, toTaskId] });
    }
    if (!toTask.blockedBy.includes(fromTaskId)) {
      await this.updateTask(toTaskId, { blockedBy: [...toTask.blockedBy, fromTaskId] });
    }
    return true;
  }

  async getAgentStatuses() {
    const result = new Map<string, string[]>();
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed' && task.owner) {
        const existing = result.get(task.owner) || [];
        existing.push(task.id);
        result.set(task.owner, existing);
      }
    }
    return Array.from(result.entries()).map(([agentId, tasks]) => ({
      agentId,
      status: 'busy' as const,
      currentTasks: tasks,
    }));
  }

  async unassignTeammateTasks(owner: string) {
    const unassignedTasks: Array<{ id: string; subject: string }> = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed' && task.owner === owner) {
        unassignedTasks.push({ id: task.id, subject: task.subject });
        await this.updateTask(task.id, { owner: undefined, status: 'pending' });
      }
    }
    return {
      unassignedTasks,
      notificationMessage: unassignedTasks.length > 0
        ? `${owner} was terminated. ${unassignedTasks.length} task(s) unassigned.`
        : '',
    };
  }
}

// ── Mock the task store module ──

const mockStore = new InMemoryTaskStore();

vi.mock('../../../src/session/task-store.js', () => ({
  getDatabaseTaskStore: vi.fn(() => mockStore),
}));

vi.mock('../../../src/session/task-output.js', () => ({
  getTaskOutputPath: vi.fn((taskId: string) => `/tmp/task-${taskId}.out`),
  writeTaskOutput: vi.fn(),
  readTaskOutput: vi.fn(() => null),
}));

// ── Helper ──

function createMockContext(sessionId = 'test-session-123') {
  return {
    toolUseId: 'ctx-test',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      sessionId,
      tools: [],
      commands: [],
      mainLoopModel: 'test',
      mcpClients: [],
    },
  };
}

// ── Tests ──

describe('TaskTool', () => {
  beforeEach(() => {
    // Reset in-memory store before each test
    (mockStore as unknown as { tasks: Map<string, Task> }).tasks = new Map();
    (mockStore as unknown as { nextId: number }).nextId = 1;
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct name', () => {
      expect(taskTool.name).toBe('task');
    });

    it('should return correct schema via toTool()', () => {
      const def = taskTool.toTool();
      expect(def.name).toBe('task');
      expect(def.input_schema.type).toBe('object');
      expect(def.input_schema.properties).toHaveProperty('action');
      expect(def.input_schema.required).toContain('action');
    });

    it('should have comprehensive prompt with usage guidance', () => {
      const prompt = taskTool.getPrompt();
      expect(prompt).toContain('create');
      expect(prompt).toContain('get');
      expect(prompt).toContain('list');
      expect(prompt).toContain('update');
      expect(prompt).toContain('output');
      expect(prompt).toContain('stop');
      expect(prompt).toContain('Examples');
    });

    it('description should include when to use guidance', () => {
      expect(taskTool.description).toContain('When to Use This Tool');
      expect(taskTool.description).toContain('When NOT to Use This Tool');
    });
  });

  describe('create action', () => {
    it('should create a task with subject and description', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'create', subject: 'Fix bug', description: 'Fix login redirect' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.id).toBe('1');
      expect(data.task.subject).toBe('Fix bug');
    });

    it('should reject create without subject', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'create', description: 'Missing subject' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('subject');
    });

    it('should reject create without description', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'create', subject: 'Missing desc' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('description');
    });

    it('should include activeForm when provided', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'create', subject: 'Test', description: 'Run tests', activeForm: 'Running tests' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.subject).toBe('Test');
    });
  });

  describe('get action', () => {
    it('should return a task by ID', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Find me', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'get', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.subject).toBe('Find me');
      expect(data.task.status).toBe('pending');
    });

    it('should return error for non-existent task', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'get', taskId: '999' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('should require taskId for get', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'get' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('taskId');
    });
  });

  describe('list action', () => {
    it('should list all tasks', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Task A', description: 'A' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'create', subject: 'Task B', description: 'B' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'list' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      expect(result.result).toContain('Task A');
      expect(result.result).toContain('Task B');
      expect(result.result).toContain('#1');
      expect(result.result).toContain('#2');
    });

    it('should return "No tasks found" when empty', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'list' },
        undefined,
        context,
      );

      expect(result.result).toBe('No tasks found');
    });
  });

  describe('update action', () => {
    it('should update task status to in_progress', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Work on it', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'update', taskId: '1', status: 'in_progress' as TaskStatus },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.status).toBe('in_progress');
    });

    it('should update task status to completed with metadata output', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Done task', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        {
          action: 'update',
          taskId: '1',
          status: 'completed' as TaskStatus,
          metadata: { output: 'Finished successfully' },
        },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.status).toBe('completed');
      expect(data.notification).toBeDefined();
    });

    it('should update subject and description', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Old', description: 'old desc' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'update', taskId: '1', subject: 'New', description: 'new desc' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.subject).toBe('New');
      expect(data.task.description).toBe('new desc');
    });

    it('should set owner', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Owned', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'update', taskId: '1', owner: 'agent-1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.owner).toBe('agent-1');
    });

    it('should set blocks/blockedBy', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Dep A', description: 'A' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'create', subject: 'Dep B', description: 'B' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'update', taskId: '2', blockedBy: ['1'] },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.task.blockedBy).toContain('1');
    });

    it('should reject invalid status', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Test', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'update', taskId: '1', status: 'invalid_status' as TaskStatus },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('Invalid status');
    });

    it('should return error for non-existent task', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'update', taskId: '999', status: 'completed' as TaskStatus },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('should require taskId for update', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'update', status: 'completed' as TaskStatus },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('taskId');
    });
  });

  describe('output action', () => {
    it('should return output for completed task with metadata', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Completed', description: 'test' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'update', taskId: '1', status: 'completed' as TaskStatus, metadata: { output: 'Great success' } },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'output', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.output).toBe('Great success');
      expect(data.source).toBe('metadata');
    });

    it('should return fallback for completed task without output', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'No output', description: 'test' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'update', taskId: '1', status: 'completed' as TaskStatus },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'output', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.output).toContain('completed successfully');
      expect(data.source).toBe('fallback');
    });

    it('should return not-completed message for pending task', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Not done', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'output', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.status).toBe('pending');
      expect(data.output).toBe('');
    });

    it('should return error for non-existent task', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'output', taskId: '999' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
    });

    it('should require taskId for output', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'output' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('taskId');
    });
  });

  describe('stop action', () => {
    it('should stop an in_progress task', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Running', description: 'test' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'update', taskId: '1', status: 'in_progress' as TaskStatus, owner: 'agent-1' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'stop', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBeFalsy();
      const data = JSON.parse(result.result);
      expect(data.status).toBe('stopped');
    });

    it('should reset task to pending and clear owner', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Running', description: 'test' },
        undefined,
        context,
      );
      await taskTool.execute(
        { action: 'update', taskId: '1', status: 'in_progress' as TaskStatus, owner: 'agent-1' },
        undefined,
        context,
      );

      await taskTool.execute(
        { action: 'stop', taskId: '1' },
        undefined,
        context,
      );

      // Verify the task was reset
      const getResult = await taskTool.execute(
        { action: 'get', taskId: '1' },
        undefined,
        context,
      );

      const data = JSON.parse(getResult.result);
      expect(data.task.status).toBe('pending');
      expect(data.task.owner).toBeUndefined();
    });

    it('should error when stopping non-in_progress task', async () => {
      const context = createMockContext();
      await taskTool.execute(
        { action: 'create', subject: 'Pending', description: 'test' },
        undefined,
        context,
      );

      const result = await taskTool.execute(
        { action: 'stop', taskId: '1' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('not in_progress');
    });

    it('should return error for non-existent task', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'stop', taskId: '999' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should error for unknown action', async () => {
      const context = createMockContext();
      const result = await taskTool.execute(
        { action: 'invalid' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('Unknown action');
    });

    it('should error without session context', async () => {
      const context = createMockContext();
      // Override with no sessionId
      context.options.sessionId = undefined as unknown as string;

      const result = await taskTool.execute(
        { action: 'list' },
        undefined,
        context,
      );

      expect(result.error).toBe(true);
      expect(result.result).toContain('No session context');
    });
  });

  describe('class instantiation', () => {
    it('should create a new instance with correct properties', () => {
      const tool = new TaskTool();
      expect(tool.name).toBe('task');
      expect(tool.toTool().name).toBe('task');
    });
  });
});
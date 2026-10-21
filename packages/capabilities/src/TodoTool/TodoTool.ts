/**
 * Todo capability — presents the session task store as the legacy
 * `todos[] + merge` tool surface.
 */

import type {
  Task,
  TaskCreateInput,
  TaskStatus,
  TaskStore,
  TaskUpdateInput,
} from '@duya/agent-protocol';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutor, ToolResult, ToolUseContext } from '../contracts/tool.js';

export const TODO_TOOL_NAME = 'todo';

/** Legacy wire names accepted during projection (normalized to 'todo'). */
export const LEGACY_TODO_WIRE_NAMES = ['TodoWrite'] as const;

export interface TodoUpdate {
  id: string;
  content?: string;
  status?: TaskStatus;
}

export interface TodoItem {
  id: string;
  content: string;
  status: TaskStatus;
}

export interface TodoWriteSuccess {
  summary_for_prompt: string;
  todos: TodoItem[];
}

/** Only the persistence operations needed by this capability. */
export type TodoTaskStore = Pick<
  TaskStore,
  'getTask' | 'listTasks' | 'createTask' | 'updateTask' | 'deleteTask'
>;

/** Host-specific binding for the session's task persistence. */
export type TodoTaskStoreResolver = (sessionId: string) => TodoTaskStore;

function toResult(name: string, payload: unknown, error?: boolean): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export class TodoTool extends BaseTool implements ToolExecutor {
  readonly name = TODO_TOOL_NAME;
  readonly description = `Create and manage a structured task list. Use for any task with 3+ steps; skip for trivial single-step work.

- Send the full list up front with merge=false to replace any existing list.
- To update, send only the items you are changing with merge=true (default). To flip a status without changing content, send just id + status.
- Ids you supply are preserved on the row. Omit id only if you do not need a stable handle — the tool will assign one. Ids must be unique within a session; pick a distinct value if the previous attempt reported a collision.
- Do not use this tool for subagent scheduling — use the \`task\` tool for that.`;

  readonly input_schema = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items to write.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the todo item.' },
            content: { type: 'string', description: 'The description/content of the todo item.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending, in_progress, or completed.' },
          },
          required: ['id'],
        },
      },
      merge: {
        type: 'boolean',
        description: "When true (default), merge into the existing list by id — send only items you are changing. When false, replace the whole list.",
      },
    },
    required: ['todos'],
  };

  constructor(private readonly resolveTaskStore: TodoTaskStoreResolver) {
    super();
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const { todos, merge } = input as { todos: TodoUpdate[]; merge?: boolean };
    const sessionId = context?.options?.sessionId;
    if (!sessionId) return toResult(this.name, { error: 'No session context available' }, true);
    if (!Array.isArray(todos)) return toResult(this.name, 'todos must be an array', true);
    if (hasDuplicateIds(todos)) return toResult(this.name, 'Each todo item must have a unique id.', true);

    const store = this.resolveTaskStore(sessionId);
    const existing = await store.listTasks();
    // Auto-upgrade to merge when the model forgot merge:true but clearly
    // intended a partial update (all updates target existing ids, no content).
    const effectiveMerge = merge
      ?? (existing.length > 0 && todos.every(t => t.content === undefined && existing.some(e => e.id === t.id)));
    if (effectiveMerge) {
      await applyMerge(store, todos);
    } else {
      await applyReplace(store, todos);
    }
    const all = (await store.listTasks()).filter(t => !t.id.startsWith('_'));
    const items: TodoItem[] = all.map(t => ({ id: t.id, content: t.subject, status: t.status }));
    return toResult(this.name, { summary_for_prompt: summarize(items), todos: items });
  }
}

function hasDuplicateIds(updates: TodoUpdate[]): boolean {
  const seen = new Set<string>();
  return updates.some(u => seen.has(u.id) ? true : (seen.add(u.id), false));
}

async function applyReplace(store: TodoTaskStore, updates: TodoUpdate[]): Promise<void> {
  for (const existing of await store.listTasks()) {
    if (!existing.id.startsWith('_')) await store.deleteTask(existing.id);
  }
  for (const update of updates) {
    const task: TaskCreateInput = {
      id: update.id,
      subject: update.content || update.id,
      description: '',
      status: update.status || 'pending',
      blocks: [],
      blockedBy: [],
    };
    await store.createTask(task);
  }
}

async function applyMerge(store: TodoTaskStore, updates: TodoUpdate[]): Promise<void> {
  for (const update of updates) {
    const current = await store.getTask(update.id);
    if (current) {
      const taskUpdates: TaskUpdateInput = {
        ...(update.content ? { subject: update.content } : {}),
        ...(update.status ? { status: update.status } : {}),
      };
      await store.updateTask(update.id, taskUpdates);
    } else {
      const task: TaskCreateInput = {
        id: update.id,
        subject: update.content || update.id,
        description: '',
        status: update.status || 'pending',
        blocks: [],
        blockedBy: [],
      };
      await store.createTask(task);
    }
  }
}

function summarize(items: TodoItem[]): string {
  if (items.length === 0) return 'No tasks currently tracked.';
  return items.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n');
}

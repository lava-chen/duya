/**
 * TodoTool - Create and manage a structured task list.
 *
 * Aligned with Grok's `todo_write` tool. Exposes a single `todos[] + merge`
 * interface and returns `summary_for_prompt + todos`. The Grok-compatible
 * legacy wire name (`TodoWrite`) is accepted during message projection and
 * normalized here via `LEGACY_TODO_WIRE_NAMES`.
 *
 * Note: the historical `task` / `Task` wire names are NOT todo aliases
 * anymore — they now belong to the subagent `task` tool (see
 * `SubagentTool/constants.ts`).
 *
 * Persistence reuses the existing `task-store` for cross-turn durability.
 * The tool surface only exposes `merge`/`todos`, hiding the store's
 * action-oriented interface.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getDatabaseTaskStore, type TaskStatus } from '../../session/task-store.js';
import type { TaskStore } from '../../session/task-store.js';

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

function toResult(
  name: string,
  payload: unknown,
  error?: boolean,
): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export class TodoTool implements Tool, ToolExecutor {
  readonly name = TODO_TOOL_NAME;
  readonly description = `Create and manage a structured task list. Use for any task with 3+ steps; skip for trivial single-step work.

- Send the full list up front with merge=false to replace any existing list.
- To update, send only the items you are changing with merge=true (default). To flip a status without changing content, send just id + status.
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

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, context?: ToolUseContext): Promise<ToolResult> {
    const { todos, merge } = input as { todos: TodoUpdate[]; merge?: boolean };
    const sessionId = context?.options?.sessionId;
    if (!sessionId) return toResult(this.name, { error: 'No session context available' }, true);
    if (!Array.isArray(todos)) return toResult(this.name, 'todos must be an array', true);
    if (hasDuplicateIds(todos)) return toResult(this.name, 'Each todo item must have a unique id.', true);

    const store = getDatabaseTaskStore(sessionId);
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

async function applyReplace(store: TaskStore, updates: TodoUpdate[]) {
  for (const e of await store.listTasks()) if (!e.id.startsWith('_')) await store.deleteTask(e.id);
  for (const u of updates) {
    await store.createTask({
      subject: u.content || u.id, description: '',
      status: u.status || 'pending', blocks: [], blockedBy: [],
    });
  }
}

async function applyMerge(store: TaskStore, updates: TodoUpdate[]) {
  for (const u of updates) {
    const cur = await store.getTask(u.id);
    if (cur) {
      await store.updateTask(u.id, {
        ...(u.content ? { subject: u.content } : {}),
        ...(u.status ? { status: u.status } : {}),
      });
    } else {
      await store.createTask({
        subject: u.content || u.id, description: '',
        status: u.status || 'pending', blocks: [], blockedBy: [],
      });
    }
  }
}

function summarize(items: TodoItem[]): string {
  if (items.length === 0) return 'No tasks currently tracked.';
  return items.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n');
}

// Export singleton instance
export const todoTool = new TodoTool();
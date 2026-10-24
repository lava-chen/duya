/**
 * The todo list the model writes, as the transcript renders it.
 *
 * ## Why this is its own module
 *
 * A todo list is not a tool RESULT, it is a piece of structured state: the
 * model asks for it, and the answer is a list of items with three statuses.
 * Rendering it as the generic "tool printed some text" path is what made the
 * CLI show `todo(todo-1, todo-2)` followed by a wall of JSON — technically the
 * data, practically unreadable.
 *
 * So the list gets its own vocabulary here, and the transcript renders THAT
 * instead of the raw result.
 *
 * ## The data source
 *
 * `TodoTool` (`packages/capabilities/src/TodoTool/TodoTool.ts`) is merge-
 * semantic: every call returns the FULL list, not a delta. That is what makes
 * this module possible without a new event channel — the `tool.call_completed`
 * payload already carries the whole list, so the CLI parses it out of the
 * result it was going to print anyway.
 *
 * ## The reference shapes
 *
 * - codex (`codex-rs/tui/src/history_cell/plans.rs`): `PlanUpdateCell` draws
 *   `• Updated Plan` over per-step markers `✔ ` / `□ `.
 * - minimax-code (`packages/tui/src/tui/transcript/view.ts`): a `kind:'todo'`
 *   cell draws `• Todo list 2/4` over markers `✓` / `●` / `×` / `○`.
 *
 * Both put the progress count in the head and one marker per item under it.
 * This module keeps the data half of that contract; the styling lives with the
 * rest of the transcript renderer.
 */

/** Status vocabulary of one todo item. Mirrors `TaskStatus` in agent-protocol. */
export type TuiTodoStatus = 'pending' | 'in_progress' | 'completed';

/** One row of the list. */
export interface TuiTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TuiTodoStatus;
}

/**
 * Tool names that write the list.
 *
 * `todo` is the canonical wire name; `TodoWrite` is the legacy alias the
 * capability still accepts during projection.
 */
const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(['todo', 'todowrite']);

/** Whether this call wrote the todo list. */
export function isTodoTool(name: string): boolean {
  return TODO_TOOL_NAMES.has(name.trim().toLowerCase());
}

/** The statuses the list may carry. Anything else reads as `pending`. */
const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

/**
 * Read the todo items out of a tool result, or `null` when it is not one.
 *
 * `null` means "this result is not a todo list" — the caller keeps whatever
 * generic rendering it had. An EMPTY array means "the list was cleared", which
 * is a real answer and not a failure.
 */
export function parseTodoItems(result: string): TuiTodoItem[] | null {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const todos = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;

  const items: TuiTodoItem[] = [];
  todos.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const content = typeof record['content'] === 'string' ? record['content'].trim() : '';
    const rawId = typeof record['id'] === 'string' ? record['id'].trim() : '';
    // The tool falls back to the id when the model sends no content, so an
    // empty row still says WHICH item it is rather than rendering blank.
    const id = rawId === '' ? `todo-${index + 1}` : rawId;
    const rawStatus = typeof record['status'] === 'string' ? record['status'] : '';
    const status = TODO_STATUSES.has(rawStatus) ? (rawStatus as TuiTodoStatus) : 'pending';
    items.push({ id, content: content === '' ? id : content, status });
  });
  return items;
}

/** What the head line says about the list. */
export interface TodoCounts {
  readonly completed: number;
  readonly total: number;
  readonly inProgress: number;
  readonly pending: number;
}

/** Count the list by status. */
export function countTodos(items: readonly TuiTodoItem[]): TodoCounts {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const item of items) {
    if (item.status === 'completed') completed += 1;
    else if (item.status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return { completed, total: items.length, inProgress, pending };
}

/**
 * A cache key for a list.
 *
 * The transcript cache keys a block on its content, so a list that changed
 * status must produce a different key — otherwise the rendered checklist would
 * stay frozen at the first version the reader saw.
 */
export function todoKey(items: readonly TuiTodoItem[] | undefined): string {
  if (items === undefined) return '';
  return items.map((item) => `${item.id}:${item.status}:${item.content}`).join('|');
}

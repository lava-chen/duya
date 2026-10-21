/**
 * Compatibility adapter for Agent's legacy tool imports and registrations.
 * Todo behavior lives in `@duya/capabilities`; this layer binds the legacy
 * session task-store resolver until Host/Runtime register the capability.
 */

import {
  TodoTool as CapabilityTodoTool,
  TODO_TOOL_NAME,
  LEGACY_TODO_WIRE_NAMES,
} from '@duya/capabilities/TodoTool/TodoTool';
import { getDatabaseTaskStore } from '@duya/host/worker-task-store';

export { TODO_TOOL_NAME, LEGACY_TODO_WIRE_NAMES };
export type { TodoItem, TodoUpdate, TodoWriteSuccess } from '@duya/capabilities/TodoTool/TodoTool';

export class TodoTool extends CapabilityTodoTool {
  constructor() {
    super((sessionId) => getDatabaseTaskStore(sessionId));
  }
}

// Compatibility singleton consumed by the existing Agent registries.
export const todoTool = new TodoTool();

/**
 * packages/cli/src/tui/slash/tasks.ts
 *
 * `/tasks` — enter the background task view.
 *
 * The list itself is chrome, not a panel: the arrows have to keep working in
 * the same live area the composer occupies, and a modal would take the
 * composer's slot away from a user who may still want to interrupt. So this
 * command hands control to `TUIApp.openTasks()` rather than rendering a body.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';

const TASKS_COMMAND: TuiSlashCommandDef = {
  name: 'tasks',
  description: 'Show background bash tasks and subagents',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    if (ctx.tui.openTasks === undefined) {
      ctx.tui.printError('This surface cannot open the task list.');
      return { kind: 'handled' };
    }
    ctx.tui.openTasks();
    return { kind: 'handled' };
  },
};

export const TASKS_COMMANDS: readonly TuiSlashCommandDef[] = [TASKS_COMMAND];

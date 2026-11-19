import { randomUUID } from 'node:crypto';
import type { TuiSlashCommandDef } from './types.js';
import { showPanel } from './shared.js';

function statusLabel(status: string): string {
  return status.trim() === '' ? 'unknown' : status;
}

function emptyLine(label: string, values: readonly string[]): readonly string[] {
  return values.length > 0 ? values : [`  (no ${label.toLowerCase()})`];
}

export const PROJECT_WORKSPACE_COMMANDS: readonly TuiSlashCommandDef[] = [
  {
    name: 'project-task',
    description: 'Accept or reject a Project Task: <task-id> accept|reject <review note>',
    group: 'Session info',
    async run(ctx, args) {
      if (!ctx.projectId) {
        ctx.tui.printError('/project-task is available in `duya project` mode.');
        return { kind: 'handled' };
      }
      const [taskId, action, ...words] = args.trim().split(/\s+/);
      const note = words.join(' ').trim();
      if (!taskId || !['accept', 'reject'].includes(action ?? '') || !note) {
        ctx.tui.printError('Usage: /project-task <task-id> accept|reject <review note>');
        return { kind: 'handled' };
      }
      try {
        const snapshot = await ctx.client.getProjectContinuity(ctx.projectId);
        const row = snapshot?.tasks.find((task) => task.link.taskId === taskId);
        if (!row?.task || snapshot?.project.coordinator_session_id !== ctx.session.id) {
          ctx.tui.printError('Task unavailable or this is no longer the current Coordinator.');
          return { kind: 'handled' };
        }
        if (row.link.revision === undefined) {
          ctx.tui.printError('This Host does not support revision-checked Task review. Rebuild and restart it.');
          return { kind: 'handled' };
        }
        const confirmed = await ctx.tui.choose(`${action === 'accept' ? 'Accept' : 'Reject'} ${row.task.subject} (r${row.link.revision})?`, [
          { value: 'confirm', label: action === 'accept' ? 'Accept Task' : 'Reject Task' },
          { value: 'cancel', label: 'Cancel' },
        ]);
        if (confirmed !== 'confirm') return { kind: 'handled' };
        const result = await ctx.client.updateProjectTaskAcceptance({ projectId: ctx.projectId, taskId,
          sessionId: ctx.session.id, requestId: randomUUID(), expectedRevision: row.link.revision,
          status: action === 'accept' ? 'accepted' : 'rejected', note });
        if (!result) ctx.tui.printError('Task review was not recorded. Refresh /project-status.');
        else ctx.tui.printNotice(`Task ${taskId}: ${result.acceptanceStatus}. Recorded as your explicit review.`);
      } catch (error) {
        ctx.tui.printError(`Could not record Task review: ${error instanceof Error ? error.message : String(error)}. Refresh /project-status before retrying.`);
      }
      return { kind: 'handled' };
    },
  },
  {
    name: 'project-status',
    description: 'Show the current Project tasks, work sessions, activity and acceptance status',
    group: 'Session info',
    async run(ctx) {
      const projectId = ctx.projectId?.trim();
      if (!projectId) {
        ctx.tui.printError('/project-status is available in `duya project` mode.');
        return { kind: 'handled' };
      }

      try {
        const state = await ctx.client.getProjectState(projectId);
        if (state === null) {
          ctx.tui.printError(`Project "${projectId}" no longer exists on this Host.`);
          return { kind: 'handled' };
        }
        const continuity = await ctx.client.getProjectContinuity(projectId, { limit: 10 });
        const acceptance = new Map(
          (continuity?.tasks ?? []).map(({ link }) => [link.taskId, link.acceptanceStatus] as const),
        );
        const taskLines = state.tasks.flatMap((task) => {
          const row = continuity?.tasks.find((item) => item.link.taskId === task.taskId);
          const latest = row?.attempts?.[0];
          return [
            `  ${task.taskId} · ${statusLabel(task.status)} · r${row?.link.revision ?? '?'} · acceptance ${acceptance.get(task.taskId) ?? 'unknown'} · ${task.subject || '(untitled)'}`,
            ...(latest ? [`    launch ${latest.status}${latest.runId ? ` · run ${latest.runId}` : ''}${latest.reason ? ` · ${latest.reason}` : ''}`] : []),
          ];
        });
        const sessionLines = state.workSessions.map((session) =>
          `  ${session.sessionId} · ${statusLabel(session.status)} · ${session.origin}${session.taskId ? ` · task ${session.taskId}` : ''} · ${session.title || '(untitled)'}`,
        );
        const activityLines = (continuity?.activity ?? []).slice(-10).reverse().map((event) => {
          const refs = [event.taskId ? `task ${event.taskId}` : '', event.sessionId ? `session ${event.sessionId}` : '', event.runId ? `run ${event.runId}` : '']
            .filter(Boolean)
            .join(' · ');
          return `  ${new Date(event.createdAt).toISOString()} · ${event.type}${refs ? ` · ${refs}` : ''}`;
        });
        const lines = [
          `Coordinator: ${state.coordinatorSessionId ?? 'unbound'}`,
          '',
          'Tasks',
          ...emptyLine('tasks', taskLines),
          '',
          'Work Sessions',
          ...emptyLine('work sessions', sessionLines),
          '',
          'Recent Activity',
          ...emptyLine('activity', activityLines),
        ];
        showPanel(ctx, `${state.project.name || state.project.project_id} · Project`, lines, {
          footer: 'Host snapshot · /project-status to refresh · Esc close',
          scrollable: true,
        });
      } catch (error) {
        ctx.tui.printError(`Could not refresh Project state: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { kind: 'handled' };
    },
  },
];

import type { SessionId } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';

export interface ProjectSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly state: 'Needs input' | 'Running' | 'Failed' | 'Cancelled' | 'Finished' | 'Idle' | 'Unknown';
}

export interface ProjectWorkbenchSummary {
  readonly name: string;
  readonly taskCounts: readonly { label: string; count: number }[];
  readonly sessions: readonly ProjectSessionSummary[];
  readonly status: 'loading' | 'current' | 'unavailable';
  readonly error?: string;
}

const STATUS_ORDER: readonly ProjectSessionSummary['state'][] = ['Needs input', 'Running', 'Failed', 'Cancelled', 'Idle', 'Finished', 'Unknown'];
const RECENT_RUN_LIMIT = 24;

export function projectDisplayLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}

export async function readProjectWorkbench(
  client: HostSessionHttpClient, projectId: string,
): Promise<Omit<ProjectWorkbenchSummary, 'status'>> {
  const [state, permissions] = await Promise.all([
    client.getProjectState(projectId),
    client.listPendingPermissionRequests().catch(() => []),
  ]);
  if (state === null) throw new Error('Project no longer exists.');
  const needsInput = new Set(permissions.filter((request) => request.status === 'pending').map((request) => request.sessionId));
  const tasks = new Map(state.tasks.map((task) => [task.taskId, task]));
  const work = [...state.workSessions].sort((a, b) => {
    const active = (taskId: string | null): boolean => taskId !== null && tasks.get(taskId)?.status === 'in_progress';
    return Number(active(b.taskId)) - Number(active(a.taskId)) || b.updatedAt - a.updatedAt;
  });
  const sessions: ProjectSessionSummary[] = [];
  for (let offset = 0; offset < work.length; offset += 6) {
    const batch = await Promise.all(work.slice(offset, offset + 6).map(async (session, index): Promise<ProjectSessionSummary> => {
      const title = projectDisplayLine((session.taskId === null ? undefined : tasks.get(session.taskId)?.subject)
        || session.title || session.sessionId.slice(0, 8));
      const id = session.sessionId;
      if (needsInput.has(id as SessionId)) return { id, title, state: 'Needs input' };
      if (offset + index >= RECENT_RUN_LIMIT) return { id, title, state: 'Unknown' };
      try {
        const [run] = await client.listAgentRunsBySession(id as SessionId, 1);
        return { id, title, state: run === undefined ? 'Idle' : run.status === 'running' ? 'Running'
          : run.status === 'completed' ? 'Finished' : run.status === 'cancelled' ? 'Cancelled' : 'Failed' };
      } catch {
        return { id, title, state: 'Unknown' };
      }
    }));
    sessions.push(...batch);
  }
  sessions.sort((a, b) => STATUS_ORDER.indexOf(a.state) - STATUS_ORDER.indexOf(b.state));
  const counts = new Map<string, number>();
  for (const { status } of state.tasks) counts.set(status, (counts.get(status) ?? 0) + 1);
  return {
    name: projectDisplayLine(state.project.name),
    sessions,
    taskCounts: Array.from(counts, ([label, count]) => ({ label: label.replace(/_/gu, ' '), count })),
  };
}

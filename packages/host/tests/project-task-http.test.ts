import { afterEach, describe, expect, it } from 'vitest';
import { projectTaskFixture } from './project-task-fixture.js';
import { HostSessionHttpServer } from '../src/http-server.js';
import { HostSessionHttpClient } from '../src/http-client.js';

const servers: HostSessionHttpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function fixture() {
  const f = projectTaskFixture();
  const server = new HostSessionHttpServer({ api: {} as never, taskApi: {} as never, token: 'test-token', projectApi: f.api });
  servers.push(server);
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  const client = new HostSessionHttpClient(origin, 'test-token');
  return { ...f, origin, client };
}

describe('Project Task HTTP control plane', () => {
  it('creates, updates and dispatches the SAME canonical Task, then persists a human review', async () => {
    const f = await fixture();
    const input = { projectId: f.projectId, coordinatorSessionId: f.coordinatorId, requestId: 'create', subject: 'Implement billing', description: 'Ship with tests' };
    const created = await f.client.createProjectTask(input);
    expect(await f.client.createProjectTask(input)).toEqual(created);
    const taskId = created.link.taskId;
    const updated = await f.client.updateProjectTask({ projectId: f.projectId, coordinatorSessionId: f.coordinatorId,
      taskId, expectedRevision: 0, description: 'Ship with integration tests' });
    expect(updated.link.revision).toBe(1);
    expect(updated.task?.description).toBe('Ship with integration tests');
    await expect(f.client.updateProjectTask({ projectId: f.projectId, coordinatorSessionId: f.coordinatorId,
      taskId, expectedRevision: 0, subject: 'Stale' })).rejects.toThrow('revision_conflict');
    const attempt = f.lifecycle.begin(f.projectId, taskId, f.coordinatorId, 1);
    f.lifecycle.bind(attempt.attempt_id, taskId, 'worker-1');
    f.lifecycle.finish(attempt.attempt_id, taskId, 'completed', null, 'run-1');
    const snapshot = await f.client.getProjectContinuity(f.projectId);
    const row = snapshot!.tasks[0]!;
    expect(row).toMatchObject({ task: { status: 'completed' }, link: { acceptanceStatus: 'pending' },
      attempts: [{ workSessionId: 'worker-1', runId: 'run-1', status: 'completed' }] });
    const review = { projectId: f.projectId, taskId, sessionId: f.coordinatorId, expectedRevision: row.link.revision!,
      requestId: 'accept', status: 'accepted' as const, note: 'Integration tests checked' };
    expect(await f.client.updateProjectTaskAcceptance(review)).toMatchObject({ acceptanceStatus: 'accepted' });
    expect(await f.client.updateProjectTaskAcceptance(review)).toMatchObject({ acceptanceStatus: 'accepted' });
    expect(f.projects.listActivity(f.projectId).filter((event) => event.event_type === 'task.accepted')).toHaveLength(1);
  });

  it('rejects forged user_message sources and unknown task fields at the HTTP boundary', async () => {
    const f = await fixture();
    const response = await fetch(`${f.origin}/v1/projects/${f.projectId}/tasks/task-1/acceptance`, {
      method: 'PUT', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted', source: { type: 'user_message', id: 'fabricated' } }),
    });
    expect(response.status).toBe(400);
    const create = await fetch(`${f.origin}/v1/projects/${f.projectId}/task-records`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorSessionId: f.coordinatorId, requestId: 'r', subject: 'x', description: 'y', actor: 'user' }),
    });
    expect(create.status).toBe(400);
    expect(f.tasks.getBySession(f.coordinatorId)).toEqual([]);
  });
});

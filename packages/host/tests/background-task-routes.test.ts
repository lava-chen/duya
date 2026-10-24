import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { HostLocalBackgroundTaskApiV1 } from '@duya/agent-protocol';
import { routeBackgroundTasks } from '../src/background-task-routes.js';

interface Captured {
  status: number;
  body: unknown;
}

async function call(
  target: string,
  api: HostLocalBackgroundTaskApiV1 | undefined,
  method = 'GET',
): Promise<Captured> {
  let captured: Captured = { status: 0, body: null };
  await routeBackgroundTasks(
    { method } as IncomingMessage,
    new URL(`http://127.0.0.1${target}`),
    {} as ServerResponse,
    api,
    { sendJson: (_response, status, body) => { captured = { status, body }; } },
  );
  return captured;
}

function api(overrides: Partial<HostLocalBackgroundTaskApiV1> = {}): HostLocalBackgroundTaskApiV1 {
  return {
    listBackgroundTasks: async () => ({ observed: true, tasks: [] }),
    readBackgroundTaskOutput: async (sessionId, taskId) =>
      sessionId === 's1' && taskId === 't1'
        ? { taskId, text: 'tail', totalBytes: 4, truncated: false }
        : null,
    ...overrides,
  };
}

describe('background task routes', () => {
  it('fails closed when the Host has no worker execution', async () => {
    expect(await call('/v1/local/background-tasks?sessionId=s1', undefined)).toEqual({
      status: 404,
      body: { error: { code: 'background_task_api_unavailable' } },
    });
  });

  it('refuses a request that does not name one session', async () => {
    const apiImpl = api();
    expect((await call('/v1/local/background-tasks', apiImpl)).status).toBe(400);
    expect((await call('/v1/local/background-tasks?sessionId=', apiImpl)).status).toBe(400);
    expect((await call('/v1/local/background-tasks?sessionId=s1&other=1', apiImpl)).status).toBe(400);
  });

  it('lists for the named session only', async () => {
    const seen: string[] = [];
    const captured = await call('/v1/local/background-tasks?sessionId=s1', api({
      listBackgroundTasks: async (sessionId) => {
        seen.push(sessionId);
        return { observed: true, tasks: [] };
      },
    }));
    expect(captured).toEqual({ status: 200, body: { observed: true, tasks: [] } });
    expect(seen).toEqual(['s1']);
  });

  it('serves the output tail and validates maxBytes', async () => {
    expect(await call('/v1/local/background-tasks/t1/output?sessionId=s1', api())).toEqual({
      status: 200,
      body: { taskId: 't1', text: 'tail', totalBytes: 4, truncated: false },
    });
    expect((await call('/v1/local/background-tasks/t1/output?sessionId=s1&maxBytes=0', api())).status).toBe(400);
    expect((await call('/v1/local/background-tasks/t1/output?sessionId=s1&maxBytes=abc', api())).status).toBe(400);
    expect((await call('/v1/local/background-tasks/t1/output?sessionId=s1&maxBytes=99999999', api())).status).toBe(400);
  });

  it('distinguishes an unknown task from a malformed path', async () => {
    expect(await call('/v1/local/background-tasks/t2/output?sessionId=s1', api())).toEqual({
      status: 404,
      body: { error: { code: 'background_task_not_found' } },
    });
    expect((await call('/v1/local/background-tasks/t1?sessionId=s1', api())).status).toBe(404);
    expect((await call('/v1/local/background-tasks/t1/logs?sessionId=s1', api())).status).toBe(404);
  });

  it('is read-only', async () => {
    expect(await call('/v1/local/background-tasks?sessionId=s1', api(), 'POST')).toEqual({
      status: 405,
      body: { error: { code: 'method_not_allowed' } },
    });
  });
});

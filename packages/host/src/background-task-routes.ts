/**
 * HTTP surface for background tasks.
 *
 * Two routes, both scoped by `sessionId`: the owning worker only ever reports
 * tasks for the session it was spawned for, so a caller that names another
 * session gets an empty list rather than that session's work.
 *
 * The only write is an explicit stop for a running subagent; bash task process
 * lifecycle remains owned by the existing task controls.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostLocalBackgroundTaskApiV1 } from '@duya/agent-protocol';

export const BACKGROUND_TASKS_ROOT = '/v1/local/background-tasks';

/** Larger tails are refused rather than clipped: the client asked for it. */
const MAX_OUTPUT_BYTES = 1_000_000;

interface RoutePorts {
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}

function bounded(value: string | null, max: number): value is string {
  return value !== null && value.length > 0 && value.length <= max;
}

/** Called only after the Host's existing bearer and Origin checks. */
export async function routeBackgroundTasks(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  api: HostLocalBackgroundTaskApiV1 | undefined,
  ports: RoutePorts,
): Promise<void> {
  const send = (status: number, body: unknown): void => ports.sendJson(response, status, body);
  if (!api) {
    send(404, { error: { code: 'background_task_api_unavailable' } });
    return;
  }
  const sessionId = url.searchParams.get('sessionId');
  if (!bounded(sessionId, 200)) {
    send(400, { error: { code: 'invalid_background_task_request' } });
    return;
  }

  if (url.pathname === BACKGROUND_TASKS_ROOT) {
    if (request.method !== 'GET') {
      send(405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if ([...url.searchParams.keys()].some((key) => key !== 'sessionId')) {
      send(400, { error: { code: 'invalid_background_task_request' } });
      return;
    }
    send(200, await api.listBackgroundTasks(sessionId));
    return;
  }

  const prefix = `${BACKGROUND_TASKS_ROOT}/`;
  if (!url.pathname.startsWith(prefix)) {
    send(404, { error: { code: 'not_found' } });
    return;
  }
  const rest = url.pathname.slice(prefix.length).split('/');
  if (rest.length !== 2 || !bounded(rest[0] ?? null, 200)) {
    send(404, { error: { code: 'not_found' } });
    return;
  }
  const taskId = decodeURIComponent(rest[0]!);
  if (rest[1] === 'stop') {
    if (request.method !== 'POST' || [...url.searchParams.keys()].some((key) => key !== 'sessionId')) {
      send(request.method === 'POST' ? 400 : 405, { error: { code: request.method === 'POST' ? 'invalid_background_task_request' : 'method_not_allowed' } });
      return;
    }
    if (api.stopSubagentTask === undefined) {
      send(404, { error: { code: 'background_task_stop_unavailable' } });
      return;
    }
    send(200, { stopped: await api.stopSubagentTask(sessionId, taskId) });
    return;
  }
  if (request.method !== 'GET') {
    send(405, { error: { code: 'method_not_allowed' } });
    return;
  }
  if (rest[1] !== 'output') {
    send(404, { error: { code: 'not_found' } });
    return;
  }
  if ([...url.searchParams.keys()].some((key) => key !== 'sessionId' && key !== 'maxBytes')) {
    send(400, { error: { code: 'invalid_background_task_request' } });
    return;
  }

  let maxBytes: number | undefined;
  const rawMax = url.searchParams.get('maxBytes');
  if (rawMax !== null) {
    const parsed = Number(rawMax);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_OUTPUT_BYTES) {
      send(400, { error: { code: 'invalid_background_task_request' } });
      return;
    }
    maxBytes = parsed;
  }

  const output = await api.readBackgroundTaskOutput(sessionId, taskId, maxBytes);
  if (output === null) {
    send(404, { error: { code: 'background_task_not_found' } });
    return;
  }
  send(200, output);
}

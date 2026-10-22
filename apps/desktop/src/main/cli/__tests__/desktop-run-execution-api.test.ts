/**
 * The Desktop execution adapter, exercised against a stand-in Agent Server.
 *
 * ## What these tests pin down
 *
 * The adapter's job is translation, not execution, so the assertions are about
 * the wire: does a start turn reach `POST /sessions/:id/chat` as SSE with the
 * prompt intact, does a failed dispatch come back as a refusal instead of an
 * accepted run that never runs, and does a cancel target the session the ledger
 * names. The run id comes from the synchronous `active-run` read, which is the
 * only acknowledgement the SSE entry gives.
 *
 * The stand-in is a real HTTP server rather than a mocked `fetch` on purpose:
 * the adapter branches on status codes and drains a streaming body, and a mock
 * would let a wrong status mapping pass.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentServerChatBody, createDesktopRunExecutionApi } from '../desktop-run-execution-api';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A minimal Agent Server: the chat entry (SSE or a forced failure), the
 * synchronous active-run read, and the stop entry.
 */
async function fakeAgentServer(options: {
  chatStatus?: number;
  activeRunId?: string | null;
  cancelApplied?: boolean;
} = {}): Promise<{ origin: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });

    if (request.method === 'POST' && /^\/sessions\/[^/]+\/chat$/.test(request.url ?? '')) {
      const status = options.chatStatus ?? 200;
      response.writeHead(status, { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' });
      // A short stream: the adapter drains it in the background, and ending it
      // lets the test observe that the drain does not touch the caller.
      response.end(status === 200 ? 'data: {"type":"ready"}\n\n' : '{"error":"busy"}');
      return;
    }
    if (request.method === 'GET' && /^\/sessions\/[^/]+\/active-run$/.test(request.url ?? '')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ runId: options.activeRunId === undefined ? 'run-1' : options.activeRunId }));
      return;
    }
    if (request.method === 'DELETE' && /^\/sessions\/[^/]+\/chat$/.test(request.url ?? '')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, applied: options.cancelApplied ?? true }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not found"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port');
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

function adapterFor(origin: string | null, sessions: Record<string, string | null> = {}) {
  return createDesktopRunExecutionApi({
    resolveAgentServerOrigin: async () => origin,
    getSessionForRun: async (runId) => sessions[runId] ?? null,
    log: { debug() {} },
  });
}

describe('buildAgentServerChatBody', () => {
  it('forwards only the provider overrides the caller set', () => {
    const body = buildAgentServerChatBody({ sessionId: 's1', prompt: 'hello', model: 'gpt-x' });
    expect(body).toEqual({ prompt: 'hello', options: {}, providerConfig: { model: 'gpt-x' } });
  });

  it('omits providerConfig entirely when nothing overrides it', () => {
    // An empty object would read as "a config was named" and suppress the
    // Agent Server's own resolution, which is a silent behaviour change.
    const body = buildAgentServerChatBody({ sessionId: 's1', prompt: 'hello' });
    expect(body).not.toHaveProperty('providerConfig');
  });

  it('maps effort, profile and attachments into the worker options', () => {
    const body = buildAgentServerChatBody({
      sessionId: 's1',
      prompt: 'hello',
      effort: 'high',
      agentProfileId: 'ops',
      attachments: [{ path: 'a.txt' }] as never,
      workingDirectory: 'E:/work',
    });
    expect(body.options).toMatchObject({ effort: 'high', agentProfileId: 'ops', files: [{ path: 'a.txt' }] });
    expect(body.workingDirectory).toBe('E:/work');
  });
});

describe('startAgentRun', () => {
  it('dispatches the turn as SSE and names the run it opened', async () => {
    const { origin, requests } = await fakeAgentServer();
    const result = await adapterFor(origin).startAgentRun({ sessionId: 's 1', prompt: 'hello' });

    expect(result).toEqual({ accepted: true, stage: 'dispatched', runId: 'run-1' });
    const post = requests.find((entry) => entry.method === 'POST');
    expect(post?.url).toBe('/sessions/s%201/chat');
    expect(post?.headers.accept).toBe('text/event-stream');
    expect(JSON.parse(post!.body)).toMatchObject({ prompt: 'hello' });
  });

  it('refuses when the Agent Server is not running, rather than reporting a run', async () => {
    const result = await adapterFor(null).startAgentRun({ sessionId: 's1', prompt: 'hello' });
    expect(result).toMatchObject({ accepted: false, stage: 'refused_dispatch_failed' });
  });

  it('turns a failed dispatch into a refusal instead of an accepted run', async () => {
    const { origin } = await fakeAgentServer({ chatStatus: 409 });
    const result = await adapterFor(origin).startAgentRun({ sessionId: 's1', prompt: 'hello' });
    expect(result).toMatchObject({ accepted: false, stage: 'refused_dispatch_failed' });
    if (result.accepted) throw new Error('unreachable');
    expect(result.reason).toContain('409');
  });

  it('refuses when the turn was dispatched but no run id can be read', async () => {
    // The caller would otherwise receive `accepted` for a run nobody can
    // cancel or stream; the ledger-less case must surface as a failure.
    const { origin } = await fakeAgentServer({ activeRunId: null });
    const result = await adapterFor(origin).startAgentRun({ sessionId: 's1', prompt: 'hello' });
    expect(result).toMatchObject({ accepted: false, stage: 'refused_run_open_failed' });
  });
});

describe('cancelAgentRun', () => {
  it('stops the session the ledger says owns the run', async () => {
    const { origin, requests } = await fakeAgentServer();
    const api = adapterFor(origin, { 'run-1': 's1' });

    await expect(api.cancelAgentRun('run-1')).resolves.toEqual({ requested: true, runId: 'run-1' });
    const del = requests.find((entry) => entry.method === 'DELETE');
    expect(del?.url).toBe('/sessions/s1/chat');
  });

  it('refuses a run the ledger does not know, without guessing a session', async () => {
    const { origin, requests } = await fakeAgentServer();
    const api = adapterFor(origin);

    const result = await api.cancelAgentRun('run-unknown');

    expect(result).toMatchObject({ requested: false, runId: 'run-unknown' });
    expect(requests.some((entry) => entry.method === 'DELETE')).toBe(false);
  });

  it('reports a run that had already ended as not stopped', async () => {
    const { origin } = await fakeAgentServer({ cancelApplied: false });
    const api = adapterFor(origin, { 'run-1': 's1' });

    const result = await api.cancelAgentRun('run-1');

    expect(result).toMatchObject({ requested: false, runId: 'run-1' });
    expect(result.requested || (result.reason ?? '')).toBeTruthy();
  });
});

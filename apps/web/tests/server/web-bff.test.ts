import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as requestHttp } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  type HostPermissionRequest,
  manifestFingerprint,
  type HostRunApiV1,
  type RunEventEnvelope,
  type RunId,
  type RunManifest,
  type StartAgentRunInput,
} from '@duya/agent-protocol';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '@duya/host/http-server';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import { createWebBff, type WebBffHandle } from '../../src/server/web-bff.js';

const HOST_TOKEN = 'web-bff-test-host-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const bffs: WebBffHandle[] = [];
const httpHosts: HostSessionHttpServer[] = [];

afterEach(async () => {
  for (const bff of bffs.splice(0)) await bff.close();
  for (const host of httpHosts.splice(0)) await host.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function startTestHost(): Promise<LocalHostHandle> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-bff-'));
  roots.push(dataRoot);
  const host = await startLocalHost({
    dataRoot,
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: HOST_TOKEN,
    ephemeral: true,
  });
  hosts.push(host);
  return host;
}

async function startTestBff(host: LocalHostHandle): Promise<WebBffHandle> {
  const bff = await createWebBff({ hostOrigin: host.origin, hostToken: HOST_TOKEN });
  bffs.push(bff);
  return bff;
}

async function startBffForHostServer(server: HostSessionHttpServer): Promise<WebBffHandle> {
  await server.listen();
  httpHosts.push(server);
  return startTestBff({ origin: server.origin } as LocalHostHandle);
}

function startPayload(runId: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 'session-run-wire',
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-web-bff',
    payload: {
      type: 'run.started',
      manifestHash: 'manifest-hash',
      protocol: CURRENT_VERSION,
      runtime: { name: 'test-runtime', version: '1' },
    },
  } as RunEventEnvelope;
}

function completedPayload(runId: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 'session-run-wire',
    seq: 2,
    timestamp: 1_700_000_000_001,
    traceId: 'trace-web-bff',
    payload: { type: 'run.completed', status: 'completed' },
  } as RunEventEnvelope;
}

function testManifest(runId: string): RunManifest {
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'workspace-web-bff',
    roots: [],
    cwd: '/workspace',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 300_000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'test-env', hash: 'test-hash' },
    budget: {},
    deterministic: false,
  } as RunManifest;
}

async function readBootstrap(bff: WebBffHandle): Promise<{ readonly csrfToken: string }> {
  return await (await fetch(`${bff.origin}/api/bootstrap`)).json() as { csrfToken: string };
}

function mutationHeaders(bff: WebBffHandle, csrfToken: string): HeadersInit {
  return {
    origin: bff.origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-duya-csrf': csrfToken,
  };
}

async function getWithHostHeader(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(new URL(url), { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end();
  });
}

describe('Web BFF over the real local Host HTTP listener', () => {
  it('keeps the Host bearer server-side and exposes only a redacted capability handshake', async () => {
    const host = await startTestHost();
    const bff = await startTestBff(host);
    const response = await fetch(`${bff.origin}/api/handshake`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('protocol');
    expect(body).toHaveProperty('provides');
    expect(body).not.toHaveProperty('host');
    expect(JSON.stringify(body)).not.toContain(HOST_TOKEN);
  }, 30_000);

  it('returns a process CSRF token and refuses cross-origin or tokenless mutations', async () => {
    const host = await startTestHost();
    const bff = await startTestBff(host);
    const bootstrapResponse = await fetch(`${bff.origin}/api/bootstrap`);
    const bootstrap = await bootstrapResponse.json() as { csrfToken: string };
    const payload = { sessionId: 'session-does-not-exist', prompt: 'hello' };

    const crossOrigin = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        'content-type': 'application/json',
        'x-duya-csrf': bootstrap.csrfToken,
      },
      body: JSON.stringify(payload),
    });
    const missingCsrf = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: { origin: bff.origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const crossSiteFetch = await fetch(`${bff.origin}/api/sessions`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const foreignReadOrigin = await fetch(`${bff.origin}/api/sessions`, {
      headers: { origin: 'https://attacker.invalid' },
    });
    const foreignBootstrapOrigin = await fetch(`${bff.origin}/api/bootstrap`, {
      headers: { origin: 'https://attacker.invalid' },
    });
    const mismatchedHost = await getWithHostHeader(
      `${bff.origin}/api/bootstrap`,
      `attacker.invalid:${new URL(bff.origin).port}`,
    );

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrap.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(crossOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
    expect(crossSiteFetch.status).toBe(403);
    expect(foreignReadOrigin.status).toBe(403);
    expect(foreignBootstrapOrigin.status).toBe(403);
    expect(mismatchedHost).toBe(403);
    expect(crossOrigin.headers.get('access-control-allow-origin')).toBeNull();
  }, 30_000);

  it('lists sessions through the BFF without exposing or forwarding browser bearer credentials', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Web BFF session', mode: 'code' });
    const bff = await startTestBff(host);

    const response = await fetch(`${bff.origin}/api/sessions`);
    const page = await response.json() as { sessions: readonly { session: { id: string } }[] };
    const sessionResponse = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(session.id)}`);
    const runResponse = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(session.id)}/runs`);
    const sessionBody = await sessionResponse.json() as { session: { id: string } };
    const runBody = await runResponse.json() as { runs: readonly unknown[] };

    expect(response.status).toBe(200);
    expect(page.sessions.some((item) => item.session.id === session.id)).toBe(true);
    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.session.id).toBe(session.id);
    expect(runBody.runs).toEqual([]);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }, 30_000);

  it('does not confuse tool approval ledger entries with worker PermissionRequests', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Approval session', mode: 'code' });
    const approval = await hostClient.createToolApproval({
      id: 'approval-web-bff',
      messageId: 'message-web-bff',
      sessionId: session.id,
      scopeType: 'session',
      scopeId: session.id,
      toolName: 'read_file',
    });
    const bff = await startTestBff(host);

    const messagesResponse = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(session.id)}/messages`);
    const approvalsResponse = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(session.id)}/approvals`);
    const pending = await approvalsResponse.json() as { approvals: readonly { id: string }[] };

    expect(messagesResponse.status).toBe(200);
    expect(pending.approvals.map(({ id }) => id)).not.toContain(approval.id);
    await expect(hostClient.getToolApproval(approval.id)).resolves.toMatchObject({ status: 'pending' });
  }, 30_000);

  it.each([
    ['allow', 'allow'],
    ['deny', 'deny'],
  ] as const)('resolves the worker PermissionRequest domain with %s for a waiting client', async (decision, expectedStatus) => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Permission wait session', mode: 'code' });
    const requestId = `permission-web-bff-${decision}`;
    await hostClient.createPermissionRequest({
      id: requestId,
      sessionId: session.id,
      toolName: 'write_file',
      toolInput: { path: 'notes.txt' },
    });
    const bff = await startTestBff(host);
    let waitingStatus: string | null = 'pending';
    const waiter = (async () => {
      while (waitingStatus === 'pending') {
        const request = await hostClient.getPermissionRequest(requestId);
        waitingStatus = request?.status ?? null;
        if (waitingStatus === 'pending') await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return waitingStatus;
    })();
    const pendingResponse = await fetch(`${bff.origin}/api/sessions/${session.id}/approvals`);
    const pending = await pendingResponse.json() as { approvals: readonly HostPermissionRequest[] };
    const bootstrap = await readBootstrap(bff);
    const resolveResponse = await fetch(`${bff.origin}/api/approvals/${requestId}/resolve`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ decision }),
    });
    const result = await waiter;

    expect(pendingResponse.status).toBe(200);
    expect(pending.approvals.map(({ id }) => id)).toContain(requestId);
    expect(resolveResponse.status).toBe(200);
    expect(result).toBe(expectedStatus);
    await expect(hostClient.getPermissionRequest(requestId)).resolves.toMatchObject({ status: expectedStatus });
  }, 30_000);

  it('maps start and cancel to the Host execution API without forwarding extra authority fields', async () => {
    const started: StartAgentRunInput[] = [];
    const cancelled: { runId: string; reason: string | undefined }[] = [];
    const runId = 'run-web-bff' as RunId;
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
      runExecutionApi: {
        async startAgentRun(input) {
          started.push(input);
          return { accepted: true, stage: 'dispatched', runId };
        },
        async cancelAgentRun(id, reason) {
          cancelled.push({ runId: id, reason });
          return { requested: true, runId: id };
        },
      },
    });
    const bff = await startBffForHostServer(host);
    const bootstrap = await readBootstrap(bff);

    const invalidStart = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello', workingDirectory: 'C:\\' }),
    });
    const startResponse = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello' }),
    });
    const startBody = await startResponse.json() as { runId: string; accepted: boolean };
    const cancelResponse = await fetch(`${bff.origin}/api/runs/${runId}/cancel`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ reason: 'user_cancel' }),
    });

    expect(invalidStart.status).toBe(400);
    expect(startBody).toMatchObject({ accepted: true, runId });
    expect(started).toEqual([{ sessionId: 'session-1', prompt: 'hello', origin: 'user' }]);
    expect(cancelResponse.status).toBe(200);
    expect(cancelled).toEqual([{ runId, reason: 'user_cancel' }]);
  }, 30_000);

  it('replays SSE after the supplied cursor and preserves the Host event envelopes', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ id: 'session-run-wire', title: 'Run stream', mode: 'code' });
    const runId = 'run-web-bff-replay' as RunId;
    const manifest = testManifest(runId);
    const fence = { epoch: 0, writer: 'web-bff-test' };
    await hostClient.createAgentRun({
      runId,
      sessionId: session.id,
      manifest,
      manifestHash: manifestFingerprint(manifest),
      inputHash: 'input-hash',
    });
    await hostClient.appendAgentRunEvents(runId, [startPayload(runId), completedPayload(runId)], fence);
    await hostClient.settleAgentRun(runId, { status: 'completed' }, fence);
    const bff = await startTestBff(host);

    const response = await fetch(`${bff.origin}/api/runs/${runId}/events`, {
      headers: { 'last-event-id': '1' },
    });
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).toContain('id: 2\nevent: run\n');
    expect(stream).not.toContain('id: 1\nevent: run\n');
    expect(stream).toContain(JSON.stringify(completedPayload(runId)));
  }, 30_000);

  it('cancels its upstream Host event subscription when the browser disconnects', async () => {
    const runId = 'run-web-bff-live' as RunId;
    const sessionId = 'session-run-wire';
    let sourceClosed = false;
    const first = startPayload(runId);
    const next: RunEventEnvelope = {
      ...first,
      seq: 2,
      payload: { type: 'assistant.status', message: 'Working' },
    } as RunEventEnvelope;
    const runApi = {
      async getAgentRun() {
        return {
          runId,
          sessionId,
          manifest: testManifest(runId),
          manifestHash: 'manifest-hash',
          inputHash: 'input-hash',
          status: 'running',
          terminal: null,
          metrics: null,
          origin: 'user',
          parentRunId: null,
          createdAt: 1_700_000_000_000,
          startedAt: 1_700_000_000_000,
          finishedAt: null,
        };
      },
      async readAgentRunEvents() {
        return [first];
      },
    } as unknown as HostRunApiV1;
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
      runApi,
      runExecutionApi: {
        async startAgentRun() {
          return { accepted: false, stage: 'refused_run_open_failed', reason: 'test-only' };
        },
        async cancelAgentRun(id) {
          return { requested: true, runId: id };
        },
        watchLiveAgentRunEvents(_id, query) {
          return (async function* () {
            try {
              yield next;
              await new Promise<void>((resolve) => {
                if (query?.signal?.aborted) resolve();
                else query?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
            } finally {
              sourceClosed = true;
            }
          })();
        },
      },
    });
    const bff = await startBffForHostServer(host);
    const abortController = new AbortController();
    const response = await fetch(`${bff.origin}/api/runs/${runId}/events`, { signal: abortController.signal });
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    abortController.abort();
    await reader.cancel().catch(() => undefined);

    const deadline = Date.now() + 2_000;
    while (!sourceClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(firstChunk.value)).toContain('event: run');
    expect(sourceClosed).toBe(true);
  }, 30_000);
});

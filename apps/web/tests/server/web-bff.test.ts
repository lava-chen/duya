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

async function getWithHeaders(url: string, headers: Record<string, string>): Promise<{ readonly status: number; readonly body: string; readonly responseHeaders: Headers }> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(new URL(url), { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), responseHeaders });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

describe('Web BFF over the real local Host HTTP listener', () => {
  it('serves same-origin browser assets and permits only browser document navigation with sec-fetch-site none', async () => {
    const host = await startTestHost();
    const staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-static-'));
    roots.push(staticRoot);
    await fs.writeFile(path.join(staticRoot, 'index.html'), '<main>shared app shell</main>');
    await fs.mkdir(path.join(staticRoot, 'assets'));
    await fs.writeFile(path.join(staticRoot, 'assets', 'app.js'), 'globalThis.webAppReady = true;');
    await fs.mkdir(path.join(staticRoot, 'fonts'));
    await fs.writeFile(path.join(staticRoot, 'fonts', 'sample.woff2'), Buffer.from([0, 1, 2, 3]));
    const bff = await createWebBff({ hostOrigin: host.origin, hostToken: HOST_TOKEN, staticRoot });
    bffs.push(bff);

    const navigationHeaders = {
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    const navigation = await getWithHeaders(`${bff.origin}/chat/session-123`, {
      host: new URL(bff.origin).host,
      ...navigationHeaders,
    });
    const script = await fetch(`${bff.origin}/assets/app.js`);
    const font = await fetch(`${bff.origin}/fonts/sample.woff2`);
    const unlisted = await fetch(`${bff.origin}/private.txt`);
    const nonNavigation = await getWithHeaders(`${bff.origin}/chat/session-123`, {
      host: new URL(bff.origin).host,
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });

    expect(navigation.status).toBe(200);
    expect(navigation.body).toContain('shared app shell');
    expect(navigation.responseHeaders.get('content-security-policy')).toContain("script-src 'self'");
    expect(navigation.responseHeaders.get('content-security-policy')).not.toContain('unsafe-eval');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(script.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await script.text()).toContain('webAppReady');
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(unlisted.status).toBe(404);
    expect(nonNavigation.status).toBe(403);
  }, 30_000);

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

  it('limits browser session creation to Host-registered workspace references', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const workspaceDirectory = roots[roots.length - 1];
    if (workspaceDirectory === undefined) throw new Error('test workspace directory missing');
    const workspace = await hostClient.registerLocalDirectory(workspaceDirectory);
    const bff = await startTestBff(host);
    const { csrfToken } = await readBootstrap(bff);

    const createdResponse = await fetch(`${bff.origin}/api/sessions`, {
      method: 'POST',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        workspaceRootId: workspace.rootId,
        workspaceRelativePath: '',
        title: 'Created in Web',
        mode: 'code',
      }),
    });
    const created = await createdResponse.json() as { session: { id: string; updatedAt: number; title: string } };
    expect(createdResponse.status).toBe(201);
    expect(created.session.title).toBe('Created in Web');

    const updatedResponse = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(created.session.id)}`, {
      method: 'PATCH',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({ expectedUpdatedAt: created.session.updatedAt, patch: { title: 'Updated in Web' } }),
    });
    const updated = await updatedResponse.json() as { updated: boolean; session?: { title: string; updatedAt: number } };
    expect(updatedResponse.status).toBe(200);
    expect(updated.updated).toBe(true);
    expect(updated.session?.title).toBe('Updated in Web');
    if (updated.session === undefined) throw new Error('Host update omitted the session record');

    const deletedResponse = await fetch(
      `${bff.origin}/api/sessions/${encodeURIComponent(created.session.id)}?expectedUpdatedAt=${updated.session.updatedAt}`,
      { method: 'DELETE', headers: { origin: bff.origin, 'x-duya-csrf': csrfToken } },
    );
    expect(deletedResponse.status).toBe(200);

    const rawPathResponse = await fetch(`${bff.origin}/api/sessions`, {
      method: 'POST',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({ workingDirectory: workspaceDirectory, title: 'Must be rejected' }),
    });
    const unboundResponse = await fetch(`${bff.origin}/api/sessions`, {
      method: 'POST',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({ title: 'Must be rejected' }),
    });
    const invalidPermissionCreate = await fetch(`${bff.origin}/api/sessions`, {
      method: 'POST',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        workspaceRootId: workspace.rootId,
        permissionMode: ['auto'],
      }),
    });
    const invalidPermissionPatch = await fetch(`${bff.origin}/api/sessions/${encodeURIComponent(created.session.id)}`, {
      method: 'PATCH',
      headers: mutationHeaders(bff, csrfToken),
      body: JSON.stringify({ patch: { permissionMode: ['auto'] } }),
    });
    expect(rawPathResponse.status).toBe(400);
    expect(unboundResponse.status).toBe(400);
    expect(invalidPermissionCreate.status).toBe(400);
    expect(invalidPermissionPatch.status).toBe(400);
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

  it('carries the model, provider and thinking effort the shared renderer sends', async () => {
    const started: StartAgentRunInput[] = [];
    const runId = 'run-web-bff-effort' as RunId;
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
      runExecutionApi: {
        async startAgentRun(input) {
          started.push(input);
          return { accepted: true, stage: 'dispatched', runId };
        },
      },
    });
    const bff = await startBffForHostServer(host);
    const bootstrap = await readBootstrap(bff);

    const startResponse = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({
        sessionId: 'session-1',
        prompt: 'hello',
        model: 'proof-model',
        providerId: 'browser-proof',
        effort: 'high',
      }),
    });
    const unknownEffort = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello', effort: 'turbo' }),
    });
    const rawOptions = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello', options: { maxTurns: 999 } }),
    });

    expect(startResponse.status).toBe(202);
    expect(started).toEqual([{
      sessionId: 'session-1',
      prompt: 'hello',
      origin: 'user',
      model: 'proof-model',
      providerId: 'browser-proof',
      options: { effort: 'high' },
    }]);
    expect(unknownEffort.status).toBe(400);
    expect(rawOptions.status).toBe(400);
    expect(started).toHaveLength(1);
  }, 30_000);

  it('carries the turn configuration the shared renderer names', async () => {
    // The permission mode, the agent profile and the declared modes are the
    // user's decisions about HOW the turn runs. A browser that could not name
    // them would run every turn under the Host's defaults, with nothing on
    // screen saying so — which is the same as the browser deciding for them.
    const started: StartAgentRunInput[] = [];
    const runId = 'run-web-bff-config' as RunId;
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
      runExecutionApi: {
        async startAgentRun(input) {
          started.push(input);
          return { accepted: true, stage: 'dispatched', runId };
        },
      },
    });
    const bff = await startBffForHostServer(host);
    const bootstrap = await readBootstrap(bff);

    const startResponse = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({
        sessionId: 'session-1',
        prompt: 'hello',
        permissionMode: 'bypassPermissions',
        agentProfileId: 'reviewer',
        modes: ['plan'],
        tools: ['read_file'],
      }),
    });
    const unknownMode = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello', permissionMode: 'auto' }),
    });
    const emptyModeName = await fetch(`${bff.origin}/api/runs/start`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello', modes: ['  '] }),
    });

    expect(startResponse.status).toBe(202);
    expect(started).toEqual([{
      sessionId: 'session-1',
      prompt: 'hello',
      origin: 'user',
      permissionMode: 'bypassPermissions',
      agentProfileId: 'reviewer',
      modes: ['plan'],
      tools: ['read_file'],
    }]);
    // `auto` is the AGENT's vocabulary, not the protocol's. A request naming it
    // is a request the Host cannot honour, so it is refused rather than run
    // under something the user did not ask for.
    expect(unknownMode.status).toBe(400);
    expect(emptyModeName.status).toBe(400);
    expect(started).toHaveLength(1);
  }, 30_000);

  it('registers a local directory as a workspace the browser can then use', async () => {
    // The browser names a DIRECTORY; the Host resolves it and returns a
    // workspace BINDING. The browser never gets to name the path the worker
    // runs in — it asks for a directory to be registered, and the Host decides
    // what that becomes.
    const host = await startTestHost();
    const bff = await startTestBff(host);
    const bootstrap = await readBootstrap(bff);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-workspace-'));
    roots.push(directory);

    const response = await fetch(`${bff.origin}/api/workspaces/local-directories`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ directory }),
    });
    const body = await response.json() as { workspace: { workspaceId: string; rootId: string; state: string } };
    const relative = await fetch(`${bff.origin}/api/workspaces/local-directories`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ directory: 'relative/path' }),
    });
    const foreignKey = await fetch(`${bff.origin}/api/workspaces/local-directories`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ directory, workspaceId: 'browser-chosen' }),
    });

    expect(response.status).toBe(201);
    expect(body.workspace.state).toBe('bound');
    expect(body.workspace.workspaceId).not.toBe('');
    expect(body.workspace.rootId).not.toBe('');
    // A relative path would resolve against the BFF's own working directory,
    // which is not a workspace anybody asked for.
    expect(relative.status).toBe(400);
    // The browser cannot choose the identity of the binding it gets.
    expect(foreignKey.status).toBe(400);
  }, 30_000);

  it('serves the Host provider roster the browser model picker reads', async () => {
    // The roster the browser shows is the roster the Host adjudicates a
    // turn's model against. A fake Host serves one, and the BFF has to pass
    // it through UNCHANGED: a reshaped roster could let the picker offer a
    // model the Host would refuse.
    const catalog = {
      providers: [
        {
          providerId: 'openai',
          name: 'OpenAI',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          hasApiKey: true,
          defaultModel: 'gpt-5',
          models: [{ modelId: 'gpt-5', displayName: 'GPT-5' }],
        },
      ],
      activeProviderId: 'openai',
      activeModel: 'gpt-5',
      configRoot: '/tmp/duya-web-bff-catalog',
    };
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
      localProviderCatalogApi: {
        async getProviderCatalog() {
          return catalog;
        },
      },
    });
    const bff = await startBffForHostServer(host);

    const response = await fetch(`${bff.origin}/api/providers/catalog`);
    const body = await response.json() as { catalog: typeof catalog };

    expect(response.status).toBe(200);
    expect(body.catalog).toEqual(catalog);
    // The roster says whether a provider HAS a key; it never carries one.
    expect(JSON.stringify(body)).not.toMatch(/sk-[A-Za-z0-9]/);
  }, 30_000);

  it('reports no roster instead of failing when the Host has no provider catalog', async () => {
    // A Host composed without the local provider catalog refuses the read.
    // That is the absence of a roster, not a failure of the read, and the
    // browser can draw "nothing here" but not "something went wrong".
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
    });
    const bff = await startBffForHostServer(host);

    const response = await fetch(`${bff.origin}/api/providers/catalog`);
    const body = await response.json() as { catalog: unknown };

    expect(response.status).toBe(200);
    expect(body.catalog).toBeNull();
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

/**
 * The checkout and integration namespaces (plan 621).
 *
 * The BFF is a FORWARDER here, and the tests hold it to that: the Host owns
 * the session -> checkout -> pull-request mapping, so the facade may not
 * re-derive it. Every assertion below therefore checks the answer the Host
 * gave, not a shape the facade invented — and the refusal cases check that a
 * refusal travels as an answer rather than as an empty result.
 */
describe('Web BFF over the Host checkout and integration namespaces', () => {
  it('forwards the checkout observation of a session', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Checkout session', mode: 'code' });
    const bff = await startTestBff(host);

    const response = await fetch(`${bff.origin}/api/checkouts?sessionId=${encodeURIComponent(session.id)}`);
    const body = await response.json() as {
      checkout: { sessionId: string; checkout: unknown; isOwner: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.checkout.sessionId).toBe(session.id);
    // "This session is not inside a managed checkout" is the Host's ANSWER.
    // It is not the same as "this surface cannot observe checkouts", and the
    // facade must not blur the two.
    expect(body.checkout.checkout).toBeNull();
    expect(body.checkout.isOwner).toBe(false);
  }, 30_000);

  it('forwards one checkout by its root path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-checkout-'));
    roots.push(directory);
    const host = await startTestHost();
    const bff = await startTestBff(host);

    const response = await fetch(`${bff.origin}/api/checkouts?root=${encodeURIComponent(directory)}`);
    const body = await response.json() as {
      checkout: {
        root: string;
        registered: boolean;
        reclaimable: boolean;
        retainReason: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.checkout.root).toBe(directory);
    // A plain directory is not a managed linked worktree, and the Host says
    // so with the condition that refused it.
    expect(body.checkout.registered).toBe(false);
    expect(body.checkout.reclaimable).toBe(false);
    expect(body.checkout.retainReason).toBe('not_registered');
  }, 30_000);

  it('refuses a checkout query that names no selector or names both', async () => {
    const host = await startTestHost();
    const bff = await startTestBff(host);

    const neither = await fetch(`${bff.origin}/api/checkouts`);
    const both = await fetch(`${bff.origin}/api/checkouts?sessionId=session-1&root=${encodeURIComponent('/tmp')}`);
    const neitherBody = await neither.json() as { error: { code: string } };
    const bothBody = await both.json() as { error: { code: string } };

    expect(neither.status).toBe(400);
    expect(both.status).toBe(400);
    expect(neitherBody.error.code).toBe('invalid_checkout_query');
    expect(bothBody.error.code).toBe('invalid_checkout_query');
  }, 30_000);

  it('treats a reclaim refusal as the Host\'s answer, not as a failure', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-reclaim-'));
    roots.push(directory);
    const host = await startTestHost();
    const bff = await startTestBff(host);
    const bootstrap = await readBootstrap(bff);

    const response = await fetch(`${bff.origin}/api/checkouts/reclaim`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ root: directory }),
    });
    const body = await response.json() as { result: { removed: boolean; reason?: string } };

    expect(response.status).toBe(200);
    // The Host re-evaluated its conditions and declined; nothing was deleted,
    // and that is an answer rather than an error.
    expect(body.result.removed).toBe(false);
    expect(body.result.reason).toBe('not_registered');
  }, 30_000);

  it('forwards the integration projection of a session and its explicit refresh', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Integration session', mode: 'code' });
    const bff = await startTestBff(host);
    const bootstrap = await readBootstrap(bff);

    const recordsResponse = await fetch(`${bff.origin}/api/integrations?sessionId=${encodeURIComponent(session.id)}`);
    const records = await recordsResponse.json() as { records: unknown[] };
    const syncResponse = await fetch(`${bff.origin}/api/integrations/sync`, {
      method: 'POST',
      headers: mutationHeaders(bff, bootstrap.csrfToken),
      body: JSON.stringify({ sessionId: session.id }),
    });
    const sync = await syncResponse.json() as {
      result: { status: string; written: unknown[]; failed: unknown[] };
    };

    expect(recordsResponse.status).toBe(200);
    expect(records.records).toEqual([]);
    expect(syncResponse.status).toBe(200);
    // A session with no working directory has nothing to sync. The Host names
    // that outcome instead of reporting a generic success.
    expect(sync.result.status).toBe('no_checkpoints');
    expect(sync.result.written).toEqual([]);
    expect(sync.result.failed).toEqual([]);
  }, 30_000);

  it('refuses an integration query that names no session', async () => {
    const host = await startTestHost();
    const bff = await startTestBff(host);

    const response = await fetch(`${bff.origin}/api/integrations`);
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_integration_query');
  }, 30_000);

  it('gates both mutations behind the same-origin CSRF token', async () => {
    const host = await startTestHost();
    const bff = await startTestBff(host);
    const bootstrap = await readBootstrap(bff);

    const reclaimWithoutToken = await fetch(`${bff.origin}/api/checkouts/reclaim`, {
      method: 'POST',
      headers: { origin: bff.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ root: '/tmp/never-removed' }),
    });
    const reclaimFromForeignOrigin = await fetch(`${bff.origin}/api/checkouts/reclaim`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        'content-type': 'application/json',
        'x-duya-csrf': bootstrap.csrfToken,
      },
      body: JSON.stringify({ root: '/tmp/never-removed' }),
    });
    const syncWithoutToken = await fetch(`${bff.origin}/api/integrations/sync`, {
      method: 'POST',
      headers: { origin: bff.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    });
    const reclaimBody = await reclaimWithoutToken.json() as { error: { code: string } };
    const foreignBody = await reclaimFromForeignOrigin.json() as { error: { code: string } };
    const syncBody = await syncWithoutToken.json() as { error: { code: string } };

    expect(reclaimWithoutToken.status).toBe(403);
    expect(reclaimBody.error.code).toBe('csrf_failed');
    expect(reclaimFromForeignOrigin.status).toBe(403);
    expect(foreignBody.error.code).toBe('origin_not_allowed');
    expect(syncWithoutToken.status).toBe(403);
    expect(syncBody.error.code).toBe('csrf_failed');
  }, 30_000);

  it('reports a Host that does not serve the namespace instead of an empty answer', async () => {
    const host = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: HOST_TOKEN,
    });
    const bff = await startBffForHostServer(host);

    const checkoutResponse = await fetch(`${bff.origin}/api/checkouts?sessionId=session-1`);
    const checkoutBody = await checkoutResponse.json() as { error: { code: string } };
    const integrationResponse = await fetch(`${bff.origin}/api/integrations?sessionId=session-1`);
    const integrationBody = await integrationResponse.json() as { error: { code: string } };

    // A Host composed without the checkout authority says so with a named
    // code. Answering "this session has no checkout" instead would let a
    // client treat an unsupported Host as a supported one.
    expect(checkoutResponse.status).toBe(404);
    expect(checkoutBody.error.code).toBe('checkout_api_unavailable');
    expect(integrationResponse.status).toBe(404);
    expect(integrationBody.error.code).toBe('integration_api_unavailable');
  }, 30_000);
});

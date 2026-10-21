import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';

const roots: string[] = [];
const savedDataRoot = process.env.DUYA_DATA_ROOT;
const savedTestMode = process.env.DUYA_TEST;

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
  else process.env.DUYA_DATA_ROOT = savedDataRoot;
  if (savedTestMode === undefined) delete process.env.DUYA_TEST;
  else process.env.DUYA_TEST = savedTestMode;
  // The Host's supervised worker is killed ASYNCHRONOUSLY: `close()` sends the
  // termination signal and returns, and the child flushes its last log line
  // into this data root on the way out. Removing the root underneath that
  // write is a race, and it lost once on CI with `ENOTEMPTY: directory not
  // empty, rmdir` — the root was re-populated between the removal listing it
  // and the final rmdir. Node's `fs.rm` retries ENOTEMPTY (and EBUSY/EPERM)
  // when `maxRetries` is set, which is the window this teardown needs; the
  // worker is force-killed three seconds after the signal, so the window
  // comfortably covers the slowest shutdown.
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface ProviderRequest {
  readonly prompt: string;
  readonly messages: readonly { readonly role?: unknown; readonly content?: unknown }[];
  readonly tools: readonly { readonly name?: unknown }[];
}

interface ProviderFixture {
  readonly origin: string;
  readonly requests: ProviderRequest[];
  readonly errors: string[];
  readonly responses: string[];
  close(): Promise<void>;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return '';
    const value = block as Record<string, unknown>;
    if (typeof value.text === 'string') return value.text;
    if (value.type === 'tool_result') return contentText(value.content);
    return '';
  }).filter(Boolean).join('\n');
}

function firstUserPrompt(messages: ProviderRequest['messages']): string {
  const latestPrompt = [...messages].reverse().find((message) => {
    if (message.role !== 'user') return false;
    if (!Array.isArray(message.content)) return true;
    return !message.content.every((block) => typeof block === 'object' && block !== null &&
      (block as Record<string, unknown>).type === 'tool_result');
  });
  return contentText(latestPrompt?.content);
}

function transcriptText(messages: ProviderRequest['messages']): string {
  return messages.map((message) => contentText(message.content)).join('\n');
}

function toolResultsText(messages: ProviderRequest['messages']): string {
  return messages.flatMap((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return [];
    return message.content.flatMap((block) => {
      if (typeof block !== 'object' || block === null || (block as Record<string, unknown>).type !== 'tool_result') return [];
      return [contentText((block as Record<string, unknown>).content)];
    });
  }).join('\n');
}

function toolUseIds(messages: ProviderRequest['messages']): ReadonlySet<string> {
  return new Set(messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
    return message.content.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      const value = block as Record<string, unknown>;
      return value.type === 'tool_use' && typeof value.id === 'string' ? [value.id] : [];
    });
  }));
}

function sse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function textStream(text: string, id: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function toolUseStream(name: string, id: string, input: Record<string, unknown>): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function catalogSessionToolId(results: string): string | undefined {
  return catalogResultValues(results).flatMap((value) => {
    const record = value as { matches?: { tool_id?: unknown; name?: unknown }[]; tool_id?: unknown };
    if (typeof record.tool_id === 'string') return [record.tool_id];
    const entry = record.matches?.find((item) => item.name === 'session');
    return typeof entry?.tool_id === 'string' ? [entry.tool_id] : [];
  })[0];
}

function catalogResultValues(results: string): unknown[] {
  const values: unknown[] = [];
  const marker = '<!-- duya-tool-catalog-result -->';
  let cursor = 0;
  while ((cursor = results.indexOf(marker, cursor)) >= 0) {
    const start = results.indexOf('{', cursor + marker.length);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < results.length; index += 1) {
      const char = results[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) break;
    try {
      values.push(JSON.parse(results.slice(start, end)) as unknown);
    } catch {
      // Ignore malformed catalog output while scanning unrelated tool results.
    }
    cursor = end;
  }
  return values;
}

function sessionInvocationStream(id: string, toolId: string, action: string, input: Record<string, unknown>): string {
  return toolUseStream('tool_invoke', id, { tool_id: toolId, arguments: { action, ...input } });
}

function responseForParentTurn(results: string, workspace: string, priorToolUseIds: ReadonlySet<string>): string {
  const toolId = catalogSessionToolId(results);
  const childIds = [...results.matchAll(/Spawned session ([0-9a-f-]{36})/giu)].map((match) => match[1] as string);
  const childOneId = childIds[0];
  const childTwoId = childIds[1];
  if (!priorToolUseIds.has('parent-session-search')) return toolUseStream('tool_catalog', 'parent-session-search', { query: 'session' });
  if (!priorToolUseIds.has('parent-session-schema')) {
    if (!toolId) throw new Error(`session tool was absent from catalog results: ${results}`);
    return toolUseStream('tool_catalog', 'parent-session-schema', { tool_id: toolId });
  }
  if (!priorToolUseIds.has('parent-spawn-one')) {
    if (!toolId) throw new Error(`session tool ID was not retained in catalog results: ${results}`);
    return sessionInvocationStream('parent-spawn-one', toolId, 'spawn', {
      prompt: 'CHILD_ONE_FIRST: complete this deterministic child task.', workingDirectory: workspace,
    });
  }
  if (!priorToolUseIds.has('parent-spawn-two')) {
    if (!toolId) throw new Error(`session tool ID was not retained in catalog results: ${results}`);
    return sessionInvocationStream('parent-spawn-two', toolId, 'spawn', {
      prompt: 'CHILD_TWO_BLOCK: wait for the parent to cancel this run.', workingDirectory: workspace,
    });
  }
  if (!priorToolUseIds.has('parent-reply-one')) {
    if (!toolId || !childOneId || !childTwoId) throw new Error(`parent did not receive both spawned session ids: ${results}`);
    return sessionInvocationStream('parent-reply-one', toolId, 'reply', {
      sessionId: childOneId, prompt: 'CHILD_ONE_FOLLOWUP: return the follow-up completion marker.',
    });
  }
  if (!priorToolUseIds.has('parent-cancel-two')) {
    if (!toolId || !childTwoId) throw new Error(`parent did not receive the second spawned session id: ${results}`);
    return sessionInvocationStream('parent-cancel-two', toolId, 'cancel', { sessionId: childTwoId });
  }
  if (!priorToolUseIds.has('parent-get-one')) {
    if (!toolId || !childOneId) throw new Error(`parent did not receive the first spawned session id: ${results}`);
    return sessionInvocationStream('parent-get-one', toolId, 'get', { sessionId: childOneId });
  }
  if (!priorToolUseIds.has('parent-list-children')) {
    if (!toolId) throw new Error(`session tool ID was not retained in catalog results: ${results}`);
    return sessionInvocationStream('parent-list-children', toolId, 'list', {});
  }
  return textStream('PARENT_CHILD_SESSIONS_DONE', 'parent-final');
}

async function startScriptedProvider(workspace: string, clientRef: { current?: HostSessionHttpClient }): Promise<ProviderFixture> {
  const requests: ProviderRequest[] = [];
  const errors: string[] = [];
  const responses: string[] = [];
  let childTwoSeen = false;
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    try {
      const payload = JSON.parse(await readRequest(request)) as {
        messages?: { role?: unknown; content?: unknown }[];
        tools?: { name?: unknown }[];
      };
      const messages = payload.messages ?? [];
      const prompt = firstUserPrompt(messages);
      const transcript = transcriptText(messages);
      const record: ProviderRequest = { prompt, messages, tools: payload.tools ?? [] };
      requests.push(record);
      let body: string;
      if (prompt.includes('PARENT_CHILD_SESSIONS_VERTICAL') || transcript.includes('PARENT_CHILD_SESSIONS_VERTICAL')) {
        const parentResults = toolResultsText(messages);
        const priorToolUseIds = toolUseIds(messages);
        if (priorToolUseIds.has('parent-spawn-two') && !priorToolUseIds.has('parent-reply-one')) {
          const childOneId = toolResultsText(messages).match(/Spawned session ([0-9a-f-]{36})/iu)?.[1];
          if (!childOneId || !clientRef.current) throw new Error('parent follow-up turn has no child session or Host client');
          await waitFor(async () => (await clientRef.current!.listAgentRunsBySession(childOneId)).some((run) => run.status === 'completed'));
          await waitFor(() => childTwoSeen);
        }
        if (priorToolUseIds.has('parent-reply-one') && !priorToolUseIds.has('parent-cancel-two')) {
          const priorResults = toolResultsText(messages);
          if (priorResults.includes('Could not reply')) throw new Error(`SessionTool reply returned an error: ${priorResults.slice(-800)}`);
          const childOneId = toolResultsText(messages).match(/Spawned session ([0-9a-f-]{36})/iu)?.[1];
          if (!childOneId || !clientRef.current) throw new Error('parent follow-up turn has no child session or Host client');
          await waitFor(async () => (await clientRef.current!.listAgentRunsBySession(childOneId))
            .filter((run) => run.status === 'completed').length >= 2);
        }
        body = responseForParentTurn(parentResults, workspace, priorToolUseIds);
      } else if (prompt.includes('CHILD_ONE_FOLLOWUP')) {
        body = textStream('CHILD_ONE_FOLLOWUP_COMPLETED', 'child-one-followup');
      } else if (prompt.includes('CHILD_ONE_FIRST')) {
        body = textStream('CHILD_ONE_FIRST_COMPLETED', 'child-one-first');
      } else if (prompt.includes('CHILD_TWO_BLOCK')) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.flushHeaders();
        childTwoSeen = true;
        return;
      } else {
        throw new Error(`unexpected provider prompt: ${prompt}`);
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
        'content-length': Buffer.byteLength(body),
      });
      const responseLabel = `${promptForDiagnostic(record)} => ${body.includes('PARENT_CHILD_SESSIONS_DONE') ? 'parent-final' : body.includes('tool_use') ? 'tool-use' : 'text'}`;
      responses.push(`${responseLabel} end-called`);
      response.once('finish', () => responses.push(`${responseLabel} finish`));
      response.end(body);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      errors.push(`${promptForDiagnostic(requests.at(-1))}: ${message}`);
      response.writeHead(500, { 'content-type': 'text/plain' }).end(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('scripted provider did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    responses,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function promptForDiagnostic(request: ProviderRequest | undefined): string {
  return request?.prompt.slice(0, 120) ?? '(no provider request recorded)';
}

async function waitFor(check: () => boolean | void | Promise<boolean | void>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value === undefined || value) return;
    } catch {
      // The child session may not be visible until the spawn transaction commits.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs} ms`);
}

async function approveSessionToolRequests(
  client: HostSessionHttpClient,
  parentSessionId: string,
  parentRunId: string,
  providerRequests: readonly ProviderRequest[],
  providerErrors: readonly string[],
  providerResponses: readonly string[],
): Promise<number> {
  const deadline = Date.now() + 15_000;
  let approvedCount = 0;
  while (Date.now() < deadline) {
    const pending = await client.listPendingPermissionRequests(parentSessionId);
    for (const request of pending) {
      if (request.toolName !== 'session') continue;
      await client.resolvePermissionRequest(request.id, {
        status: 'allow',
        decision: `approved by local Host child-session integration test for run ${parentRunId}`,
      });
      approvedCount += 1;
    }
    const run = await client.getAgentRun(parentRunId as import('@duya/agent-protocol').RunId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return approvedCount;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pending = await client.listPendingPermissionRequests(parentSessionId);
  const run = await client.getAgentRun(parentRunId as import('@duya/agent-protocol').RunId);
  const events = await client.readAgentRunEvents(parentRunId as import('@duya/agent-protocol').RunId, { afterSeq: 0 });
  throw new Error(`parent run ${parentRunId} did not finish while approving session tool requests: ${JSON.stringify({
    runStatus: run?.status,
    terminal: run?.terminal,
    pending: pending.map(({ id, toolName, status, message }) => ({ id, toolName, status, message })),
    eventTypes: events.map((event) => ({ seq: event.seq, type: event.payload.type,
      toolName: 'toolName' in event.payload ? event.payload.toolName : undefined,
      status: 'status' in event.payload ? event.payload.status : undefined,
      toolCallId: 'toolCallId' in event.payload ? event.payload.toolCallId : undefined,
      error: 'error' in event.payload ? event.payload.error : undefined })),
    provider: providerRequests.map((request) => ({ prompt: request.prompt.slice(0, 120), result: toolResultsText(request.messages).slice(-300) })),
    lastProviderCalls: providerRequests.slice(-4).map((request) => ({
      prompt: request.prompt.slice(0, 120),
      toolUseIds: [...toolUseIds(request.messages)],
      results: toolResultsText(request.messages).slice(-1_000),
    })),
    providerErrors,
    providerResponses,
  })}`);
}

describe('Host worker child-session vertical execution', () => {
  it('spawns isolated real child runs, follows up, cancels a sibling, and reads results through the parent tool', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-child-sessions-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const clientRef: { current?: HostSessionHttpClient } = {};
    const provider = await startScriptedProvider(workspace, clientRef);
    delete process.env.DUYA_TEST;
    process.env.DUYA_DATA_ROOT = root;
    await fs.writeFile(path.join(root, 'config.toml'),
      `[model]\nprovider = "local-test"\ndefault = "test-model"\n\n` +
      `[providers.local-test]\nproviderType = "anthropic"\nbaseUrl = "${provider.origin}"\n\n` +
      `[providers.local-test.options]\ndefaultModel = "test-model"\n`, 'utf8');
    await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.local-test.apiKey': 'vertical-test-key' }), 'utf8');

    let host: LocalHostHandle | undefined;
    try {
      const productionWorkerPath = path.resolve(process.cwd(), 'packages/host/bundle/worker-entry.js');
      await fs.access(productionWorkerPath);
      const workerPath = path.join(root, 'worker-entry-test-wrapper.cjs');
      await fs.writeFile(workerPath,
        `delete process.env.VITEST;\n` +
        `require(${JSON.stringify(productionWorkerPath)});\n`, 'utf8');
      host = await startLocalHost({
        dataRoot: root,
        rolloutRoot: path.join(root, 'sessions'),
        attachmentsRoot: path.join(root, 'attachments'),
        runtimeFilePath: path.join(root, 'runtime', 'host-api.json'),
        port: 0,
        token: 'host-child-sessions-token',
        workerPath,
        betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
        ephemeral: true,
      });
      const client = new HostSessionHttpClient(host.origin, 'host-child-sessions-token');
      clientRef.current = client;
      const parentId = 'sess-host-child-sessions-parent' as import('@duya/agent-protocol').SessionId;
      const binding = await client.registerLocalDirectory(workspace);
      await client.create({
        id: parentId,
        workspaceId: binding.workspaceId,
        workspaceRootId: binding.rootId,
        workspaceRelativePath: binding.relativePath,
        title: 'child-session parent',
        projectName: 'child-session-test',
        status: 'active',
        model: 'test-model',
        providerId: 'local-test',
        permissionMode: 'default',
      });

      const started = await client.startAgentRun({
        sessionId: parentId,
        prompt: 'PARENT_CHILD_SESSIONS_VERTICAL: delegate, follow up, cancel one sibling, then inspect your child results.',
        options: { maxTurns: 16 },
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
      });
      expect(started.accepted).toBe(true);
      if (!started.accepted) return;
      const approvalTask = approveSessionToolRequests(client, parentId, started.runId, provider.requests, provider.errors, provider.responses)
        .then((count) => ({ count }), (error: unknown) => ({ error }));

      let parent = await client.getAgentRun(started.runId);
      await waitFor(async () => {
        parent = await client.getAgentRun(started.runId);
        return Boolean(parent && parent.status !== 'running');
      }, 15_000);
      const approvalResult = await approvalTask;
      if ('error' in approvalResult) throw approvalResult.error;
      expect(approvalResult.count).toBeGreaterThan(0);
      const parentEvents = await client.readAgentRunEvents(started.runId, { afterSeq: 0 });
      const children = (await client.listLocalSessions({ parentSessionId: parentId, includeAllSessions: true })).sessions;
      const childRunSnapshot = await Promise.all(children.map(async (child) => ({
        id: child.id,
        runs: (await client.listAgentRunsBySession(child.id as import('@duya/agent-protocol').SessionId))
          .map((run) => ({ runId: run.runId, status: run.status, parentRunId: run.parentRunId, origin: run.origin })),
      })));
      const pendingPermissions = await client.listPendingPermissionRequests(parentId);
      expect(parent?.status, JSON.stringify({
        status: parent?.status,
        terminal: parent?.terminal,
        prompts: provider.requests.map((request) => request.prompt.slice(0, 180)),
        toolResults: provider.requests.map((request) => toolResultsText(request.messages).slice(-500)),
        events: parentEvents.map((event) => ({ seq: event.seq, type: event.payload.type,
          toolCallId: 'toolCallId' in event.payload ? event.payload.toolCallId : undefined,
          toolName: 'toolName' in event.payload ? event.payload.toolName : undefined })),
        children: childRunSnapshot,
        pendingPermissions: pendingPermissions.map(({ id, toolName, status, message }) => ({ id, toolName, status, message })),
      })).toBe('completed');
      expect(parentEvents.some((event) => event.payload.type === 'assistant.text_block' && event.payload.text.includes('PARENT_CHILD_SESSIONS_DONE')),
        JSON.stringify({
          providerRequests: provider.requests.map((request) => ({ prompt: request.prompt.slice(0, 180), results: toolResultsText(request.messages).slice(-500) })),
          parentEventTypes: parentEvents.map((event) => event.payload.type),
          parentText: parentEvents.filter((event) => event.payload.type === 'assistant.text_block')
            .map((event) => event.payload.type === 'assistant.text_block' ? event.payload.text : ''),
          lastPrompt: provider.requests.at(-1)?.prompt,
        })).toBe(true);

      expect(children).toHaveLength(2);
      const runsByChild = await Promise.all(children.map(async (child) => ({
        child,
        runs: await client.listAgentRunsBySession(child.id as import('@duya/agent-protocol').SessionId),
      })));
      for (const { runs } of runsByChild) {
        for (const run of runs) {
          expect(run.parentRunId).toBe(started.runId);
          expect(run.origin).toBe('agent');
          expect(parent?.manifest.budget.maxTurns).toBe(16);
          expect(run.manifest.budget.maxTurns).toBe(16);
        }
      }
      const completedChild = runsByChild.find(({ runs }) => runs.length === 2 && runs.every((run) => run.status === 'completed'));
      const cancelledChild = runsByChild.find(({ runs }) => runs.length === 1 && runs[0]?.status === 'cancelled');
      expect(completedChild, JSON.stringify(runsByChild.map(({ child, runs }) => ({ id: child.id, runs: runs.map((run) => ({ id: run.runId, status: run.status })) })))).toBeDefined();
      expect(cancelledChild, JSON.stringify(runsByChild.map(({ child, runs }) => ({ id: child.id, runs: runs.map((run) => ({ id: run.runId, status: run.status })) })))).toBeDefined();
      expect(provider.requests.some((request) => request.prompt.includes('CHILD_ONE_FIRST'))).toBe(true);
      expect(provider.requests.some((request) => request.prompt.includes('CHILD_ONE_FOLLOWUP'))).toBe(true);
      expect(provider.requests.some((request) => request.prompt.includes('CHILD_TWO_BLOCK'))).toBe(true);
      const initialParentRequest = provider.requests.find((request) => request.prompt.includes('PARENT_CHILD_SESSIONS_VERTICAL'));
      expect(initialParentRequest?.tools.some((tool) => tool.name === 'tool_catalog')).toBe(true);
      expect(initialParentRequest?.tools.some((tool) => tool.name === 'tool_invoke')).toBe(true);
      expect(provider.requests.some((request) => transcriptText(request.messages).includes('PARENT_CHILD_SESSIONS_VERTICAL') &&
        toolResultsText(request.messages).includes('Status: completed'))).toBe(true);
      expect(provider.requests.some((request) => transcriptText(request.messages).includes('PARENT_CHILD_SESSIONS_VERTICAL') &&
        transcriptText(request.messages).includes('CHILD_ONE_FOLLOWUP_COMPLETED'))).toBe(true);
      expect(provider.requests.some((request) => transcriptText(request.messages).includes('PARENT_CHILD_SESSIONS_VERTICAL') &&
        toolResultsText(request.messages).includes('Child sessions (2)') &&
        toolResultsText(request.messages).includes('[completed]') &&
        toolResultsText(request.messages).includes('[cancelled]'))).toBe(true);
      const followupRun = completedChild?.runs[0];
      expect(followupRun).toBeDefined();
      if (followupRun) {
        const getResultRunId = toolResultsText(provider.requests.find((request) =>
          toolUseIds(request.messages).has('parent-get-one'))?.messages ?? [])
          .match(/\bRun: ([0-9a-f-]{36})\b/u)?.[1];
        expect(getResultRunId).toBe(followupRun.runId);
        const resultEvents = await client.readAgentRunEvents(followupRun.runId, { afterSeq: 0 });
        expect(resultEvents.some((event) => event.payload.type === 'assistant.text_block' &&
          event.payload.text.includes('CHILD_ONE_FOLLOWUP_COMPLETED'))).toBe(true);
      }
    } catch (error) {
      roots.splice(roots.indexOf(root), 1);
      await host?.close();
      host = undefined;
      let hostLogTail = '';
      try {
        const hostLog = await fs.readFile(path.join(root, 'logs', 'host-run.log'), 'utf8');
        hostLogTail = hostLog.slice(-6_000);
      } catch {
        hostLogTail = '(host-run.log was not created)';
      }
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      throw new Error(`${detail}\nPreserved Host dataRoot: ${root}\nBounded host-run.log tail:\n${hostLogTail}`);
    } finally {
      await host?.close();
      await provider.close();
    }
  }, 120_000);
});

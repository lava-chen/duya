import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventSpecOf, type RunEventEnvelope } from '@duya/agent-protocol';
import { RunSession } from '@duya/client-core';
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
  // The Host's supervised worker is killed ASYNCHRONOUSLY: `close()` sends
  // the termination signal and returns, and the child flushes its last log
  // line into this data root on the way out. The test then removed that root
  // underneath the write, and the removal lost the race — ENOTEMPTY:
  // directory not empty, rmdir — because the root was re-populated between
  // the removal listing it and the final rmdir.
  //
  // Node's `fs.rm` retries ENOTEMPTY (and EBUSY/EPERM) when `maxRetries` is
  // set, which is exactly the window this teardown needs; the worker is
  // force-killed three seconds after the signal, so the window comfortably
  // covers the slowest shutdown. No assertion is touched: the same directory
  // is removed, it is just removed with a retry instead of a single shot.
  //
  // Measured on the ubuntu runner (run 39655210137): the case failed with
  // `ENOTEMPTY: directory not empty, rmdir
  // '/tmp/duya-shared-client-vertical-p67Oh7'`, and the suite reported
  // 13384 tests passed with this one failure.
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface ScriptedRequest {
  readonly prompt: string;
  readonly messages: readonly { readonly role?: unknown; readonly content?: unknown }[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return '';
    const value = block as Record<string, unknown>;
    return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
  }).join('\n');
}

function sse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function toolUseStream(filePath: string, id: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'read', input: { file_path: filePath } } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
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

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startScriptedProvider(filePath: string): Promise<{
  readonly origin: string;
  readonly requests: ScriptedRequest[];
  waitForBlockedRequest(): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: ScriptedRequest[] = [];
  let blockedRequestSeen!: () => void;
  const blockedRequest = new Promise<void>((resolve) => { blockedRequestSeen = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    try {
      const payload = JSON.parse(await readRequest(request)) as {
        messages?: { role?: unknown; content?: unknown }[];
      };
      const messages = payload.messages ?? [];
      const latestPrompt = [...messages].reverse().find((message) => message.role === 'user' &&
        !Array.isArray(message.content) ||
        (message.role === 'user' && Array.isArray(message.content) && !message.content.some((block) =>
          typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result')));
      const prompt = textOf(latestPrompt?.content);
      const requestRecord: ScriptedRequest = { prompt, messages };
      requests.push(requestRecord);
      if (prompt.includes('VERTICAL_CANCEL_RUN') && !prompt.includes('VERTICAL_RUN_TWO_AFTER_CANCEL')) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.flushHeaders();
        blockedRequestSeen();
        return;
      }
      const promptKey = prompt.includes('VERTICAL_RUN_TWO') ? 'two' : 'one';
      const readId = `read-${promptKey}`;
      const hasResult = messages.some((message) => Array.isArray(message.content) && message.content.some((block) =>
        typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result' &&
        (block as Record<string, unknown>).tool_use_id === readId));
      const body = hasResult
        ? textStream(promptKey === 'one' ? 'VERTICAL_FINAL_ONE' : 'VERTICAL_FINAL_TWO', `final-${promptKey}`)
        : toolUseStream(filePath, readId);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' }).end(error instanceof Error ? error.message : String(error));
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
    waitForBlockedRequest: () => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`provider did not receive the cancellation prompt; observed: ${requests.map((request) => request.prompt).join(' | ')}`)), 10_000);
      void blockedRequest.then(() => {
        clearTimeout(timeout);
        resolve();
      });
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function drainRun(client: HostSessionHttpClient, runId: RunEventEnvelope['runId']): Promise<RunEventEnvelope[]> {
  const events: RunEventEnvelope[] = [];
  for await (const event of client.watchAgentRunEvents(runId)) events.push(event);
  return events;
}

function durableProjection(events: readonly RunEventEnvelope[]): RunEventEnvelope[] {
  return events.filter((event) => eventSpecOf(event.payload.type)?.durability !== 'ephemeral');
}

function sharedBusinessState(events: readonly RunEventEnvelope[]): unknown {
  if (events.length === 0) return null;
  const first = events[0]!;
  const session = new RunSession({ runId: first.runId, sessionId: first.sessionId });
  const accepted = session.acceptWindow(durableProjection(events));
  if (!accepted.accepted) throw new Error(`RunSession rejected the Host event window: ${accepted.reason}`);
  const { revision: _revision, lastAcceptedSeq: _lastAcceptedSeq, timeline: _timeline, ...business } = session.getSnapshot();
  return business;
}

describe('Host shared-client vertical execution', () => {
  it('runs the production worker through a tool round, streams/replays one ledger, and isolates sequential runs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-shared-client-vertical-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const markerPath = path.join(workspace, 'marker.txt');
    await fs.writeFile(markerPath, 'VERTICAL_TOOL_RESULT_MARKER\n', 'utf8');
    const provider = await startScriptedProvider(markerPath);
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
      // Vitest marks its own process with VITEST. The fork inherits that marker,
      // which makes the production DB client correctly reject the pool's
      // process.send channel. Clear only the runner marker before loading the
      // real bundled worker so its DB bridge uses the actual fork IPC transport.
      const workerPath = path.join(root, 'worker-entry-test-wrapper.cjs');
      await fs.writeFile(workerPath,
        `delete process.env.VITEST;\nrequire(${JSON.stringify(productionWorkerPath)});\n`, 'utf8');
      host = await startLocalHost({
        dataRoot: root,
        rolloutRoot: path.join(root, 'sessions'),
        attachmentsRoot: path.join(root, 'attachments'),
        runtimeFilePath: path.join(root, 'runtime', 'host-api.json'),
        port: 0,
        token: 'shared-client-vertical-token',
        workerPath,
        betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
        ephemeral: true,
      });
      const client = new HostSessionHttpClient(host.origin, 'shared-client-vertical-token');
      const sessionId = 'sess-shared-client-vertical' as import('@duya/agent-protocol').SessionId;
      await client.createImportedSession({ sessionId, title: 'shared client vertical', workingDirectory: workspace, projectName: 'vertical-test' });

      for (const [prompt, finalText] of [
        ['VERTICAL_RUN_ONE: read marker.txt, then report its content.', 'VERTICAL_FINAL_ONE'],
        ['VERTICAL_RUN_TWO: read marker.txt, then report its content.', 'VERTICAL_FINAL_TWO'],
      ] as const) {
        const started = await client.startAgentRun({ sessionId, prompt, model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic' });
        expect(started.accepted).toBe(true);
        if (!started.accepted) return;

        const live = await drainRun(client, started.runId);
        const run = await client.getAgentRun(started.runId);
        const durable = await client.readAgentRunEvents(started.runId, { afterSeq: 0 });
        expect(run?.status, JSON.stringify({ status: run?.status, terminal: run?.terminal, metrics: run?.metrics, liveSeqs: live.map((event) => event.seq), durable, requests: provider.requests.length })).toBe('completed');
        expect(run?.terminal?.status).toBe('completed');
        expect(durable, JSON.stringify({ metrics: run?.metrics, liveSeqs: live.map((event) => event.seq), durableSeqs: durable.map((event) => event.seq) })).toEqual(durableProjection(live));
        expect(live.length).toBeGreaterThan(3);
        expect(live[0]?.seq).toBe(1);
        expect(live.every((event) => event.runId === started.runId && event.sessionId === sessionId)).toBe(true);
        expect(live.map((event) => event.seq)).toEqual([...new Set(live.map((event) => event.seq))].sort((a, b) => a - b));
        expect(live.some((event) => event.payload.type === 'tool.call_started')).toBe(true);
        expect(live.some((event) => event.payload.type === 'tool.call_completed')).toBe(true);
        // A tool that ran to completion STATES its outcome. Without the bit the
        // TUI paints `?` on every successful call.
        const completed = live.find((event) => event.payload.type === 'tool.call_completed');
        expect((completed?.payload as { outcome?: { outcome?: string } }).outcome?.outcome).toBe('success');
        expect(live.some((event) => event.payload.type === 'assistant.text_block' &&
          (event.payload as { text?: string }).text?.includes(finalText))).toBe(true);
        const replay = await client.readAgentRunEvents(started.runId, { afterSeq: 0 });
        expect(replay).toEqual(durableProjection(live));
        expect(sharedBusinessState(live)).toEqual(sharedBusinessState(replay));
      }

      expect(provider.requests.length).toBeGreaterThanOrEqual(4);
      for (const request of provider.requests) {
        expect(request.prompt).toMatch(/VERTICAL_RUN_(ONE|TWO)/u);
      }
      for (const prompt of ['VERTICAL_RUN_ONE', 'VERTICAL_RUN_TWO']) {
        const requestsForRun = provider.requests.filter((request) => request.prompt.includes(prompt));
        expect(requestsForRun.length).toBeGreaterThanOrEqual(2);
        expect(requestsForRun.some((request) => JSON.stringify(request.messages).includes('VERTICAL_TOOL_RESULT_MARKER'))).toBe(true);
      }

      const cancelledStart = await client.startAgentRun({
        sessionId,
        prompt: 'VERTICAL_CANCEL_RUN: keep the provider request open until Host cancellation.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
      });
      expect(cancelledStart.accepted).toBe(true);
      if (!cancelledStart.accepted) return;
      await provider.waitForBlockedRequest();
      const cancellation = await client.cancelAgentRun(cancelledStart.runId, 'vertical test cancel');
      expect(cancellation.requested).toBe(true);
      expect((await client.getAgentRun(cancelledStart.runId))?.terminal?.status).toBe('cancelled');

      const afterCancel = await client.startAgentRun({
        sessionId,
        prompt: 'VERTICAL_RUN_TWO_AFTER_CANCEL: read marker.txt, then report its content.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
      });
      expect(afterCancel.accepted).toBe(true);
      if (!afterCancel.accepted) return;
      let afterCancelRecord = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        afterCancelRecord = await client.getAgentRun(afterCancel.runId);
        if (afterCancelRecord?.terminal !== null && afterCancelRecord?.terminal !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const afterCancelReplay = await client.readAgentRunEvents(afterCancel.runId, { afterSeq: 0 });
      expect(afterCancelRecord?.status, JSON.stringify({ status: afterCancelRecord?.status, eventTypes: afterCancelReplay.map((event) => [event.seq, event.payload.type]), prompts: provider.requests.map((request) => request.prompt) })).toBe('completed');
      expect(afterCancelReplay.some((event) => event.payload.type === 'assistant.text_block' &&
        (event.payload as { text?: string }).text?.includes('VERTICAL_FINAL_TWO'))).toBe(true);
    } finally {
      await host?.close();
      await provider.close();
    }
  }, 120_000);
});

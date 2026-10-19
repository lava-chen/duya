import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const DELEGATION_WORKER_SOURCE = `
let dbSeq = 0;
let runSeq = 0;
let textIndex = 0;
let activeRun = null;
const pending = new Map();

process.on('message', (message) => {
  if (message && message.type === 'db:response' && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.success) entry.resolve(message.result);
    else entry.reject(new Error(message.error || 'db:request failed'));
  }
});

function emitNative(payload) {
  process.send({
    type: 'run:event',
    epoch: activeRun.epoch,
    envelope: {
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      seq: ++runSeq,
      timestamp: Date.now(),
      traceId: 'trace-' + activeRun.runId,
      payload,
    },
  });
}

function emitText(text) {
  emitNative({
    type: 'assistant.text_block',
    messageId: activeRun.runId + ':message:1',
    index: textIndex++,
    text,
  });
}

function request(action, payload, execution) {
  const id = 'db-' + (++dbSeq);
  const message = { type: 'db:request', id, action, payload };
  if (execution !== undefined) message.execution = execution;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send(message);
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('db timeout: ' + action));
    }, 10000).unref();
  });
}

async function attempt(label, execution, workingDirectory) {
  try {
    const result = await request('session:spawn', {
      prompt: 'unauthorized child must not start',
      workingDirectory,
    }, execution);
    return label + ':success=' + JSON.stringify(result);
  } catch (error) {
    return label + ':error=' + error.message;
  }
}

async function run(command) {
  activeRun = {
    runId: command.runId,
    sessionId: command.sessionId,
    epoch: command.options && command.options.attemptEpoch,
    manifestHash: command.manifestHash,
  };
  runSeq = 0;
  textIndex = 0;
  emitNative({
    type: 'run.started',
    manifestHash: activeRun.manifestHash,
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'delegation-authority-test', version: '1.0.0' },
  });
  emitNative({
    type: 'turn.started',
    turnId: activeRun.runId + ':turn:1',
    index: 1,
    model: 'stub-model',
    providerId: 'stub-provider',
    apiFormat: 'anthropic',
  });

  let result;
  try {
    const spec = JSON.parse(command.prompt);
    if (spec.kind === 'first') {
      const current = { sessionId: activeRun.sessionId, runId: activeRun.runId, epoch: activeRun.epoch };
      emitText('issued=' + JSON.stringify(current));
      result = await request('session:spawnList', {}, current);
      emitText('valid-list=' + JSON.stringify(result));
      emitText(await attempt('missing', undefined, spec.workingDirectory));
      emitText(await attempt('fake-session', { ...current, sessionId: 'forged-session' }, spec.workingDirectory));
      emitText(await attempt('wrong-epoch', { ...current, epoch: current.epoch + 1 }, spec.workingDirectory));
    } else if (spec.kind === 'second') {
      emitText(await attempt('old-run', spec.oldExecution, spec.workingDirectory));
    } else {
      emitText('unexpected prompt kind');
    }
  } catch (error) {
    emitText('worker-error=' + error.message);
  }

  emitNative({
    type: 'turn.completed',
    turnId: activeRun.runId + ':turn:1',
    index: 1,
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durationMs: 1,
  });
  emitNative({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
  process.send({ type: 'chat:done', sessionId: activeRun.sessionId });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (command.type === 'chat:start') void run(command);
  }
});
process.on('disconnect', () => process.exit(0));
`;

async function startDelegationHost(root: string): Promise<{
  host: LocalHostHandle;
  client: HostSessionHttpClient;
  sessionId: string;
}> {
  const dataRoot = path.join(root, 'data');
  const workerPath = path.join(root, 'stub-worker-delegation.cjs');
  await fs.writeFile(workerPath, DELEGATION_WORKER_SOURCE, 'utf8');
  const host = await startLocalHost({
    dataRoot,
    databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: 'session-delegation-authority-test-token',
    workerPath,
    betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
  });
  const client = new HostSessionHttpClient(host.origin, 'session-delegation-authority-test-token');
  const sessionId = 'sess-delegation-authority-test';
  await client.createImportedSession({
    sessionId: sessionId as import('@duya/agent-protocol').SessionId,
    title: 'session delegation authority test',
    workingDirectory: root,
    projectName: 'session-delegation-authority-test',
  });
  return { host, client, sessionId };
}

async function collectRunText(
  client: HostSessionHttpClient,
  runId: string,
): Promise<string[]> {
  const text: string[] = [];
  for await (const event of client.watchAgentRunEvents(runId as import('@duya/agent-protocol').RunId)) {
    if (event.payload.type === 'assistant.text_block') text.push(event.payload.text);
  }
  return text;
}

describe('Host session delegation authority', () => {
  it('rejects missing, forged, wrong-epoch, and previous-run contexts before creating children', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-session-delegation-authority-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startDelegationHost(root);
      host = started.host;
      const { client, sessionId } = started;

      const first = await client.startAgentRun({
        sessionId,
        prompt: JSON.stringify({ kind: 'first', workingDirectory: root }),
      });
      expect(first.accepted).toBe(true);
      if (!first.accepted) return;

      const firstText = await collectRunText(client, first.runId);
      const issuedLine = firstText.find((line) => line.startsWith('issued='));
      expect(issuedLine).toBeDefined();
      const previousExecution = JSON.parse(issuedLine!.slice('issued='.length)) as {
        sessionId: string;
        runId: string;
        epoch: number;
      };

      expect(firstText).toContain('valid-list={"ok":true,"sessions":[]}');
      expect(firstText).toContain('missing:error=Session delegation requires an execution context.');
      expect(firstText).toContain('fake-session:error=Session delegation context does not match its worker.');
      expect(firstText).toContain('wrong-epoch:error=Session delegation attempt is no longer active.');
      expect((await client.getAgentRun(first.runId))?.status).toBe('completed');

      const second = await client.startAgentRun({
        sessionId,
        prompt: JSON.stringify({ kind: 'second', oldExecution: previousExecution, workingDirectory: root }),
      });
      expect(second.accepted).toBe(true);
      if (!second.accepted) return;

      const secondText = await collectRunText(client, second.runId);
      expect(secondText).toContain('old-run:error=Session delegation attempt is no longer active.');
      expect((await client.getAgentRun(second.runId))?.status).toBe('completed');

      const children = await client.list({ parentSessionId: sessionId, includeAllSessions: true });
      expect(children.sessions).toEqual([]);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

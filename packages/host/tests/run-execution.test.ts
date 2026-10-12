import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

/**
 * A minimal worker that speaks just enough of the worker protocol to prove the
 * Host execution path: it reads `chat:start` from stdin and reports frames over
 * IPC. `STUB_WORKER_MODE=hang` keeps the worker alive so cancellation can be
 * exercised for real (interrupt, grace, kill).
 */
const STUB_WORKER_SOURCE = `
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
    if (command.type !== 'chat:start') continue;
    process.send({ type: 'chat:text', data: 'stub says hi' });
    if (process.env.STUB_WORKER_MODE === 'hang') {
      process.send({ type: 'chat:status', status: 'working' });
    } else {
      process.send({ type: 'chat:done', sessionId: command.sessionId });
    }
  }
});
process.on('disconnect', () => process.exit(0));
`;

async function writeStubWorker(
  directory: string,
  mode: 'complete' | 'hang',
): Promise<string> {
  const workerPath = path.join(directory, `stub-worker-${mode}.cjs`);
  await fs.writeFile(workerPath, STUB_WORKER_SOURCE, 'utf8');
  return workerPath;
}

interface StartedHost {
  host: LocalHostHandle;
  client: HostSessionHttpClient;
  sessionId: string;
}

async function startHostWithSession(
  root: string,
  workerPath: string,
): Promise<StartedHost> {
  const dataRoot = path.join(root, 'data');
  const host = await startLocalHost({
    dataRoot,
    databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: 'run-execution-test-token',
    workerPath,
    betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
  });
  const client = new HostSessionHttpClient(host.origin, 'run-execution-test-token');
  const sessionId = 'sess-run-exec-test';
  await client.createImportedSession({
    sessionId: sessionId as import('@duya/agent-protocol').SessionId,
    title: 'run execution test',
    workingDirectory: root,
    projectName: 'run-execution-test',
  });
  return { host, client, sessionId };
}

describe('Host-owned run execution', () => {
  it('starts a real run, persists its events, and replays them after settle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-exec-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'complete');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({ sessionId, prompt: 'say hi' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      const runId = start.runId;

      // The run record exists and settles from the worker's terminal frame.
      let record = null;
      for (let i = 0; i < 100; i += 1) {
        record = await client.getAgentRun(runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record).not.toBeNull();
      expect(record?.status).toBe('completed');
      expect(record?.terminal).not.toBeNull();

      // The durable event log holds the worker's frames as protocol events.
      const events = await client.readAgentRunEvents(runId);
      const types = events.map((event) => event.payload.type);
      expect(types).toContain('assistant.text_block');
      expect(types).toContain('run.completed');

      // Replay reads the same durable sequence from a fresh cursor.
      const replay = await client.readAgentRunEvents(runId, { afterSeq: 0 });
      expect(replay.map((event) => event.seq)).toEqual(events.map((event) => event.seq));

      await host.close();
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('cancels a live run and records a cancelled terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-cancel-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'hang');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({ sessionId, prompt: 'never finish' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      const runId = start.runId;

      const cancel = await client.cancelAgentRun(runId, 'test cancel');
      expect(cancel.requested).toBe(true);

      let record = null;
      for (let i = 0; i < 150; i += 1) {
        record = await client.getAgentRun(runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record?.status).toBe('cancelled');
      expect(record?.terminal?.status).toBe('cancelled');

      await host.close();
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('refuses to start a run for a session the Host does not know', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-refuse-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'complete');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client } = started;

      const start = await client.startAgentRun({
        sessionId: 'sess-does-not-exist' as import('@duya/agent-protocol').SessionId,
        prompt: 'nope',
      });
      expect(start).toMatchObject({ accepted: false, stage: 'refused_no_session' });

      await host.close();
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

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
 * exercised for real (interrupt, grace, kill). `STUB_WORKER_MODE=db` makes the
 * worker round-trip `db:request` frames (message:append, message:getCount,
 * session:loadMessages) through the Host bridge before completing.
 */
const STUB_WORKER_SOURCE = `
// Mode comes from the filename (stub-worker-<mode>.cjs) — deterministic, no
// reliance on environment propagation through the spawn path.
const MODE = (__filename.includes('-hang-hard') && 'hang-hard')
  || (__filename.includes('-db') && 'db')
  || (__filename.includes('-hang') && 'hang')
  || 'complete';
let dbSeq = 0;
const dbPending = new Map();
process.on('message', (msg) => {
  if (msg && msg.type === 'db:response' && dbPending.has(msg.id)) {
    const { resolve, reject } = dbPending.get(msg.id);
    dbPending.delete(msg.id);
    if (msg.success) resolve(msg.result);
    else reject(new Error(msg.error || 'db:request failed'));
  }
});
function dbRequest(action, payload) {
  const id = 'db-' + (++dbSeq);
  return new Promise((resolve, reject) => {
    dbPending.set(id, { resolve, reject });
    process.send({ type: 'db:request', id, action, payload });
    setTimeout(() => {
      if (dbPending.has(id)) { dbPending.delete(id); reject(new Error('db timeout: ' + action)); }
    }, 10000);
  });
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
    // A production worker honours chat:interrupt: it stops the turn and
    // reports its own terminal frame — the CLEAN cancel path. ('hang-hard'
    // deliberately ignores the interrupt to exercise escalation.)
    if (command.type === 'chat:interrupt') {
      if (MODE === 'hang') {
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      }
      continue;
    }
    if (command.type !== 'chat:start') continue;
    if (MODE === 'db') {
      (async () => {
        try {
          const sessionId = command.sessionId;
          const append = await dbRequest('message:append', {
            sessionId,
            messages: [
              { id: 'stub-msg-user', session_id: sessionId, role: 'user', content: 'ping from stub worker' },
              { id: 'stub-msg-assistant', session_id: sessionId, role: 'assistant', content: 'pong from stub worker' },
            ],
          });
          process.send({ type: 'chat:text', data: 'append=' + JSON.stringify(append) });
          const count = await dbRequest('message:getCount', { sessionId });
          process.send({ type: 'chat:text', data: 'count=' + JSON.stringify(count) });
          const loaded = await dbRequest('session:loadMessages', { sessionId });
          const roles = (loaded.messages || []).map((m) => m.role).join(',');
          process.send({ type: 'chat:text', data: 'roles=' + roles });
        } catch (err) {
          process.send({ type: 'chat:text', data: 'dberror=' + (err && err.message) });
        }
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      })();
    } else {
      if (MODE === 'complete') {
        process.send({ type: 'chat:text', data: 'stub says hi' });
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      } else if (MODE === 'hang') {
        // Stays alive working until the interrupt arrives (handled above).
        process.send({ type: 'chat:status', status: 'working' });
      } else if (MODE === 'hang-hard') {
        // Ignores chat:interrupt on purpose: exercises interrupt-grace
        // escalation (SIGTERM) and the failed(escalated) terminal.
      }
    }
  }
});
process.on('disconnect', () => process.exit(0));
`;

async function writeStubWorker(
  directory: string,
  mode: 'complete' | 'hang' | 'hang-hard' | 'db',
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

  it('serves worker db:request frames (message domain) from Host stores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-db-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'db');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({ sessionId, prompt: 'exercise db bridge' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      const runId = start.runId;

      let record = null;
      for (let i = 0; i < 100; i += 1) {
        record = await client.getAgentRun(runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record?.status).toBe('completed');

      // The worker observed real db:responses: append accepted both entries,
      // count matches, and loadMessages projects both roles back.
      const events = await client.readAgentRunEvents(runId);
      const texts = events
        .filter((event) => event.payload.type === 'assistant.text_block')
        .map((event) =>
          (event.payload as { text?: string }).text ?? JSON.stringify(event.payload),
        )
        .join('\n');
      expect(texts).toContain('"success":true');
      expect(texts).toContain('count=2');
      expect(texts).toContain('roles=user,assistant');

      // The entries are durably readable from the Host timeline after settle.
      const page = await client.readMessages(sessionId, { limit: 50 });
      const contents = page.messages.map((item) => {
        const entry = item.entry as { message?: { content?: unknown } };
        return typeof entry.message?.content === 'string' ? entry.message.content : '';
      });
      expect(contents).toContain('ping from stub worker');
      expect(contents).toContain('pong from stub worker');

      await host.close();
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('escalates a run whose worker ignores the interrupt and records failed(escalated)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-escalate-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'hang-hard');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({ sessionId, prompt: 'never finish, never yield' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      const runId = start.runId;

      const cancel = await client.cancelAgentRun(runId, 'test escalation');
      expect(cancel.requested).toBe(true);

      let record = null;
      for (let i = 0; i < 200; i += 1) {
        record = await client.getAgentRun(runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The worker ignored the interrupt, so the clean-cancel path was NOT
      // honoured — the honest terminal is failed with escalation provenance,
      // not a fabricated cancelled.
      expect(record?.status).toBe('failed');
      expect((record?.terminal?.error as { details?: { escalated?: boolean } } | undefined)?.details?.escalated).toBe(true);

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

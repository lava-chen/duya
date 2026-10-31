import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostPermissionRequest } from '@duya/agent-protocol';
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
  || (__filename.includes('-array-action') && 'array-action')
  || (__filename.includes('-stdout-pressure') && 'stdout-pressure')
  || (__filename.includes('-permission-live') && 'permission-live')
  || (__filename.includes('-permission') && 'permission')
  || (__filename.includes('-plugin-app') && 'plugin-app')
  || (__filename.includes('-bash-task') && 'bash-task')
  || (__filename.includes('-db') && 'db')
  || (__filename.includes('-hang') && 'hang')
  || 'complete';
let dbSeq = 0;
let activeRun = null;
let runSeq = 0;
let textBlockIndex = 0;
let pendingPluginInvoke = null;
const dbPending = new Map();
process.on('message', (msg) => {
  if (msg && msg.type === 'db:response' && dbPending.has(msg.id)) {
    const { resolve, reject } = dbPending.get(msg.id);
    dbPending.delete(msg.id);
    if (msg.success) resolve(msg.result);
    else {
      const error = new Error(msg.error || 'db:request failed');
      error.code = msg.code;
      reject(error);
    }
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
function emitNative(payload) {
  if (!activeRun) return;
  process.send({
    type: 'run:event',
    epoch: activeRun.attemptEpoch,
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
function beginRun(command) {
  activeRun = {
    runId: command.runId,
    sessionId: command.sessionId,
    attemptEpoch: command.options && command.options.attemptEpoch,
    manifestHash: command.manifestHash,
  };
  runSeq = 0;
  textBlockIndex = 0;
  emitNative({
    type: 'run.started',
    manifestHash: activeRun.manifestHash,
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'stub-worker', version: '1.0.0' },
  });
}
function emitTurnStarted() {
  emitNative({
    type: 'turn.started',
    turnId: activeRun.runId + ':turn:1',
    index: 1,
    model: 'stub-model',
    providerId: 'stub-provider',
    apiFormat: 'anthropic',
  });
}
function emitTextBlock(text) {
  emitNative({
    type: 'assistant.text_block',
    messageId: activeRun.runId + ':message:1',
    index: textBlockIndex++,
    text,
  });
}
function emitTerminal(status) {
  emitNative({
    type: 'run.completed',
    status,
    ...(status === 'cancelled' ? { stopReason: 'aborted', cancelRequested: true } : { stopReason: 'end_turn' }),
  });
}
function emitTurnCompleted(stopReason) {
  emitNative({
    type: 'turn.completed',
    turnId: activeRun.runId + ':turn:1',
    index: 1,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durationMs: 1,
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
    if (command.type === 'permission:resolve' && MODE === 'plugin-app' && pendingPluginInvoke) {
      const pending = pendingPluginInvoke;
      pendingPluginInvoke = null;
      (async () => {
        if (!String(command.decision).startsWith('allow')) {
          process.send({ type: 'plugin-app:result', sessionId: pending.sessionId, runId: pending.runId,
            epoch: pending.epoch, requestId: pending.requestId,
            result: { ok: false, code: 'tool_denied', message: 'Permission denied' } });
          return;
        }
        const stillCurrent = await dbRequest('plugin-app:binding-current', {
          bindingId: pending.bindingId, nonce: pending.nonce, toolId: pending.toolId,
        });
        process.send({ type: 'plugin-app:result', sessionId: pending.sessionId, runId: pending.runId,
          epoch: pending.epoch, requestId: pending.requestId,
          result: stillCurrent
            ? { ok: true, result: { sideEffects: 1 } }
            : { ok: false, code: 'binding_revoked', message: 'Binding was revoked after approval' } });
      })().catch((err) => process.send({ type: 'plugin-app:result', sessionId: pending.sessionId,
        runId: pending.runId, epoch: pending.epoch, requestId: pending.requestId,
        result: { ok: false, code: 'worker_error', message: String(err && err.message) } }));
      continue;
    }
    if (command.type === 'plugin-app:describe-tools' && MODE === 'plugin-app') {
      process.send({ type: 'plugin-app:tools', sessionId: command.sessionId, runId: command.runId,
        epoch: command.epoch, requestId: command.requestId, tools: [{
          toolId: 'mcp:server/dashboard.read', schemaRevision: 'schema-1',
          descriptor: { source: 'plugin', serverName: 'dashboard', toolName: 'read', pluginId: 'com.duya.sample' },
        }] });
      continue;
    }
    if (command.type === 'plugin-app:invoke' && MODE === 'plugin-app') {
      (async () => {
        const stillCurrent = await dbRequest('plugin-app:binding-current', {
          bindingId: command.bindingId, nonce: command.nonce, toolId: command.toolId,
        });
        if (!stillCurrent) {
          process.send({ type: 'plugin-app:result', sessionId: command.sessionId, runId: command.runId,
            epoch: command.epoch, requestId: command.requestId,
            result: { ok: false, code: 'binding_revoked', message: 'Binding is not current' } });
          return;
        }
        pendingPluginInvoke = command;
        process.send({ type: 'chat:permission', sessionId: command.sessionId, request: {
          id: command.requestId, toolName: 'dashboard.read', toolInput: command.arguments,
          expiresAt: Date.now() + 300000,
        } });
      })().catch((err) => process.send({ type: 'plugin-app:result', sessionId: command.sessionId,
        runId: command.runId, epoch: command.epoch, requestId: command.requestId,
        result: { ok: false, code: 'worker_error', message: String(err && err.message) } }));
      continue;
    }
    if (command.type === 'permission:resolve' && MODE === 'permission') {
      emitNative({
        type: 'permission.resolved',
        requestId: 'approval-1',
        action: command.decision === 'deny' ? 'deny' : 'allow',
        source: 'host',
        latencyMs: 1,
      });
      emitTextBlock('decision=' + command.decision);
      emitTurnCompleted(command.decision === 'deny' ? 'aborted' : 'end_turn');
      emitTerminal('completed');
      process.send({ type: 'chat:text', data: 'decision=' + command.decision });
      process.send({ type: 'chat:done', sessionId: command.sessionId });
      continue;
    }
    if (command.type === 'permission:set') {
      // The live switch: the Host pushed the new mode to the worker that is
      // running THIS turn. The mode is reported back as the turn's text, so
      // the test sees what the worker was actually told.
      emitTextBlock('mode=' + command.mode);
      emitTurnCompleted('end_turn');
      emitTerminal('completed');
      process.send({ type: 'chat:done', sessionId: command.sessionId });
      continue;
    }
    // A production worker honours chat:interrupt: it stops the turn and
    // reports its own terminal frame — the CLEAN cancel path. ('hang-hard'
    // deliberately ignores the interrupt to exercise escalation.)
    if (command.type === 'chat:interrupt') {
      if (MODE === 'hang') {
        emitTerminal('cancelled');
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      }
      continue;
    }
    if (command.type !== 'chat:start') continue;
    beginRun(command);
    emitTurnStarted();
    process.send({ type: 'chat:turn_start', data: { turnCount: 1 } });
    if (command.prompt === 'continue after stop') {
      emitTextBlock('continued successfully');
      emitTurnCompleted('end_turn');
      emitTerminal('completed');
      process.send({ type: 'chat:text', content: 'continued successfully' });
      process.send({ type: 'chat:done', sessionId: command.sessionId });
      continue;
    }
    if (MODE === 'stdout-pressure') {
      (async () => {
        for (let index = 0; index < 128; index += 1) {
          if (!process.stdout.write('x'.repeat(65536))) {
            await new Promise((resolve) => process.stdout.once('drain', resolve));
          }
        }
        emitTextBlock('stdout drained');
        emitTurnCompleted('end_turn');
        emitTerminal('completed');
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      })();
    } else if (MODE === 'permission') {
      emitNative({
        type: 'tool.call_started',
        toolCallId: 'tool-approval',
        toolName: 'bash',
        arguments: { command: 'echo approved' },
        attempt: 1,
      });
      process.send({ type: 'chat:tool_use', id: 'tool-approval', name: 'bash', input: { command: 'echo approved' } });
      const request = { id: 'approval-1', toolName: 'bash', toolInput: { command: 'echo approved' }, mode: 'exit_plan_mode', reason: 'The command writes outside the workspace', expiresAt: Date.now() + 300000 };
      emitNative({
        type: 'permission.requested',
        requestId: request.id,
        kind: 'tool_use',
        toolCallId: 'tool-approval',
        toolName: request.toolName,
        toolInput: request.toolInput,
        mode: request.mode,
        reason: request.reason,
        startedAt: Date.now(),
        expiresAt: request.expiresAt,
      });
      process.send({ type: 'chat:permission', sessionId: command.sessionId, request });
    } else if (MODE === 'permission-live') {
      // Asks for an approval and then waits for the live permission switch
      // rather than for an approval decision: the point of this mode is the
      // turn that is ALREADY running.
      emitNative({
        type: 'tool.call_started',
        toolCallId: 'tool-approval',
        toolName: 'bash',
        arguments: { command: 'echo approved' },
        attempt: 1,
      });
      const request = { id: 'approval-live', toolName: 'bash', toolInput: { command: 'echo approved' }, mode: 'exit_plan_mode', reason: 'The command writes outside the workspace', expiresAt: Date.now() + 300000 };
      emitNative({
        type: 'permission.requested',
        requestId: request.id,
        kind: 'tool_use',
        toolCallId: 'tool-approval',
        toolName: request.toolName,
        toolInput: request.toolInput,
        mode: request.mode,
        reason: request.reason,
        startedAt: Date.now(),
        expiresAt: request.expiresAt,
      });
      process.send({ type: 'chat:permission', sessionId: command.sessionId, request });
    } else if (MODE === 'array-action') {
      (async () => {
        try {
          await dbRequest(['message:append'], {
            sessionId: command.sessionId,
            messages: [{ id: 'array-action-message', session_id: command.sessionId, role: 'assistant', content: 'must not persist' }],
          });
          emitTextBlock('array-action=unexpected-success');
        } catch (err) {
          emitTextBlock('array-action=' + (err && err.code) + ':' + (err && err.message));
        }
        emitTurnCompleted('end_turn');
        emitTerminal('completed');
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      })();
    } else if (MODE === 'bash-task') {
      // The shape is the worker's own registry shape (startTime / lastProgress),
      // not the HTTP summary: the Host is the one that narrows it.
      const startedAt = Date.now() - 12000;
      const outputFile = require('node:path').join(__dirname, 'bash-task-output.log');
      try { require('node:fs').writeFileSync(outputFile, 'listening on 3000\\n'); } catch {}
      process.send({
        type: 'bash_task:update',
        sessionId: command.sessionId,
        tasks: [
          { id: 'task-running', pid: 4242, outputFile, command: 'sleep 60', status: 'running',
            startTime: startedAt, lastProgress: { bytes: 18 }, autoPromoted: true },
          { id: 'task-done', pid: 4243, outputFile: '', command: 'echo hi', status: 'completed',
            startTime: startedAt - 5000, endTime: startedAt - 4000, exitCode: 0, lastProgress: { bytes: 3 } },
        ],
      });
      emitTextBlock('bash task snapshot sent');
      emitTurnCompleted('end_turn');
      emitTerminal('completed');
      process.send({ type: 'chat:done', sessionId: command.sessionId });
    } else if (MODE === 'db') {
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
          emitTextBlock('append=' + JSON.stringify(append));
          process.send({ type: 'chat:text', data: 'append=' + JSON.stringify(append) });
          const count = await dbRequest('message:getCount', { sessionId });
          emitTextBlock('count=' + JSON.stringify(count));
          process.send({ type: 'chat:text', data: 'count=' + JSON.stringify(count) });
          const loaded = await dbRequest('session:loadMessages', { sessionId });
          const roles = (loaded.messages || []).map((m) => m.role).join(',');
          emitTextBlock('roles=' + roles);
          process.send({ type: 'chat:text', data: 'roles=' + roles });
        } catch (err) {
          emitTextBlock('dberror=' + (err && err.message));
          process.send({ type: 'chat:text', data: 'dberror=' + (err && err.message) });
        }
        emitTurnCompleted('end_turn');
        emitTerminal('completed');
        process.send({ type: 'chat:done', sessionId: command.sessionId });
      })();
    } else {
      if (MODE === 'complete') {
        emitTextBlock('stub says hi');
        emitTurnCompleted('end_turn');
        emitTerminal('completed');
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
  mode: 'complete' | 'hang' | 'hang-hard' | 'db' | 'bash-task' | 'array-action' | 'permission' | 'permission-live' | 'plugin-app' | 'stdout-pressure',
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
  pluginAppInvocationAuthority?: import('../src/local-plugin-app-invocation-api.js').HostPluginAppInvocationAuthority,
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
    ...(pluginAppInvocationAuthority === undefined ? {} : { pluginAppInvocationAuthority }),
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
  it('rejects a non-string worker DB action without dispatching or writing a transcript row', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-array-action-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHostWithSession(root, await writeStubWorker(root, 'array-action'));
      host = started.host;
      const start = await started.client.startAgentRun({ sessionId: started.sessionId, prompt: 'probe non-string db action' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      let record = null;
      for (let index = 0; index < 100; index += 1) {
        record = await started.client.getAgentRun(start.runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(record?.status).toBe('completed');
      const events = await started.client.readAgentRunEvents(start.runId);
      expect(events.some((event) => event.payload.type === 'assistant.text_block' &&
        event.payload.text.includes('array-action=invalid_db_action:'))).toBe(true);

      const timeline = await started.client.readMessages(started.sessionId, { limit: 50 });
      expect(timeline.messages.some((item) => JSON.stringify(item.entry).includes('must not persist'))).toBe(false);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('drains mirrored stdout so backpressure cannot block the IPC terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-stdout-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHostWithSession(root, await writeStubWorker(root, 'stdout-pressure'));
      host = started.host;
      const { client, sessionId } = started;
      const start = await client.startAgentRun({ sessionId, prompt: 'fill stdout before completing over IPC' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      let run = await client.getAgentRun(start.runId);
      const deadline = Date.now() + 5000;
      while (run?.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        run = await client.getAgentRun(start.runId);
      }
      expect(run?.status).toBe('completed');
      const events = await client.readAgentRunEvents(start.runId);
      expect(events.some((event) => event.payload.type === 'assistant.text_block' && event.payload.text === 'stdout drained')).toBe(true);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(['allow', 'deny'] as const)('delivers a %s HTTP approval to the waiting child worker', async (status) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-approval-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHostWithSession(root, await writeStubWorker(root, 'permission'));
      host = started.host;
      const { client, sessionId } = started;
      const start = await client.startAgentRun({ sessionId, prompt: 'ask before tool execution' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;
      const events = [];
      for await (const event of client.watchAgentRunEvents(start.runId)) {
        events.push(event);
        if (event.payload.type === 'permission.requested') {
          // The record is written when the Host receives the worker's LEGACY
          // frame — a different message from the native event this branch
          // just saw. The read waits for it instead of assuming it landed.
          let pending: readonly HostPermissionRequest[] = [];
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            pending = await client.listPendingPermissionRequests(sessionId);
            if (pending.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(pending.map((p) => p.id)).toEqual(['approval-1']);
          // The record keeps the worker's own words. These are producer
          // facts: the mode says which question the user is being asked and
          // the reason says why, and neither is derivable from the tool
          // name. A record that lost them leaves the reader to guess.
          expect(pending[0]?.mode).toBe('exit_plan_mode');
          expect(pending[0]?.reason).toBe('The command writes outside the workspace');
          expect(pending[0]?.expiresAt).toBeTypeOf('number');
          const resolution = { status, decision: status === 'allow' ? 'allow_once' : 'deny' };
          expect((await client.resolvePermissionRequest('approval-1', resolution))?.status).toBe(status);
          expect(await client.resolvePermissionRequest('approval-1', resolution)).toBeNull();
        }
      }
      expect(events.some((e) => e.payload.type === 'permission.requested')).toBe(true);
      const text = events.filter((e) => e.payload.type === 'assistant.text_block').map((e) => e.payload.text);
      expect(text).toEqual(['decision=' + (status === 'allow' ? 'allow_once' : 'deny')]);
      expect((await client.getAgentRun(start.runId))?.status).toBe('completed');
      expect(await client.listPendingPermissionRequests(sessionId)).toEqual([]);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('pushes a permission-mode change to the worker that is running the turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-permission-live-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHostWithSession(root, await writeStubWorker(root, 'permission-live'));
      host = started.host;
      const { client, sessionId } = started;
      const start = await client.startAgentRun({ sessionId, prompt: 'ask before tool execution' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const events = [];
      let patched = false;
      for await (const event of client.watchAgentRunEvents(start.runId)) {
        events.push(event);
        // The turn is in flight and waiting. This is the moment a person
        // presses Shift+Tab in the TUI.
        if (!patched && event.payload.type === 'permission.requested') {
          patched = true;
          const response = await fetch(`${started.host.origin}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            headers: { authorization: 'Bearer run-execution-test-token', 'content-type': 'application/json' },
            body: JSON.stringify({ patch: { permissionMode: 'full_access' } }),
          });
          expect(response.status).toBe(200);
        }
      }
      // The worker that was running the turn was told the new mode, and it
      // was told it in the AGENT's vocabulary: the row's `full_access` is the
      // agent's `bypassPermissions`. Sending the profile as-is would have
      // landed as `default`, because the agent does not know that name.
      const text = events.filter((e) => e.payload.type === 'assistant.text_block').map((e) => e.payload.text);
      expect(text).toEqual(['mode=bypassPermissions']);
      expect((await client.getAgentRun(start.runId))?.status).toBe('completed');
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

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
      expect(types).toContain('turn.started');
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

  it('caches worker bash_task:update frames and serves them through the read API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-bash-tasks-'));
    let host: LocalHostHandle | undefined;
    try {
      const workerPath = await writeStubWorker(root, 'bash-task');
      const started = await startHostWithSession(root, workerPath);
      host = started.host;
      const { client, sessionId } = started;

      // Before the worker reports, the Host has measured nothing — which is
      // different from "nothing is running".
      expect(await client.listBackgroundTasks(sessionId)).toEqual({ observed: false, tasks: [] });

      const start = await client.startAgentRun({ sessionId, prompt: 'run a background command' });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      let record = null;
      for (let i = 0; i < 100; i += 1) {
        record = await client.getAgentRun(start.runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record?.status).toBe('completed');

      const list = await client.listBackgroundTasks(sessionId);
      expect(list.observed).toBe(true);
      // Running first, then newest; the worker's registry fields are narrowed
      // into the HTTP summary rather than passed through.
      expect(list.tasks.map((task) => [task.id, task.status])).toEqual([
        ['task-running', 'running'],
        ['task-done', 'completed'],
      ]);
      expect(list.tasks[0]).toMatchObject({ pid: 4242, outputBytes: 18, autoPromoted: true });
      expect(list.tasks[1]).toMatchObject({ exitCode: 0, outputBytes: 3 });

      // The tail is read on demand from the file the worker named. The path
      // itself never appears in the summary.
      const output = await client.readBackgroundTaskOutput(sessionId, 'task-running');
      expect(output?.text).toContain('listening on 3000');
      expect(output?.truncated).toBe(false);
      expect(await client.readBackgroundTaskOutput(sessionId, 'task-missing')).toBeNull();

      // Another session cannot see this one's snapshot.
      expect(await client.listBackgroundTasks('some-other-session')).toEqual({ observed: false, tasks: [] });

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
      // The terminal travels with the acknowledgement whenever the Host has
      // one: a client that has to ask again to learn how the run ended is a
      // client that can show "cancelling…" forever.
      if (cancel.requested && cancel.terminal !== undefined) {
        expect(cancel.terminal.status).toBe('cancelled');
      }

      let record = null;
      for (let i = 0; i < 150; i += 1) {
        record = await client.getAgentRun(runId);
        if (record?.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record?.status).toBe('cancelled');
      expect(record?.terminal?.status).toBe('cancelled');
      const next = await client.startAgentRun({ sessionId, prompt: 'continue after stop' });
      expect(next).toMatchObject({ accepted: true });
      if (next.accepted) {
        for await (const _event of client.watchAgentRunEvents(next.runId)) { /* Drain to the real terminal. */ }
        expect((await client.getAgentRun(next.runId))?.status).toBe('completed');
      }

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

      // The Host stamps every message row a worker writes during a live run
      // with the owning run id - the worker payload is not authority.
      const stamped = page.messages.filter((item) =>
        (item.entry as { type?: string } | undefined)?.type === 'message');
      expect(stamped.length).toBeGreaterThanOrEqual(2);
      for (const item of stamped) {
        expect((item.entry as { runId?: string }).runId).toBe(runId);
      }

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
      const next = await client.startAgentRun({ sessionId, prompt: 'continue after stop' });
      expect(next).toMatchObject({ accepted: true });
      if (next.accepted) {
        for await (const _event of client.watchAgentRunEvents(next.runId)) { /* Drain to the real terminal. */ }
        expect((await client.getAgentRun(next.runId))?.status).toBe('completed');
      }

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

  it.each(['allow', 'deny', 'revoke', 'remap'] as const)(
    'routes a trusted Plugin App invocation through the live worker and rechecks after %s approval',
    async (decision) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-run-plugin-app-'));
      let host: LocalHostHandle | undefined;
      let descriptorMappingCurrent = true;
      try {
        const authority: import('../src/local-plugin-app-invocation-api.js').HostPluginAppInvocationAuthority = {
          resolveApp: async (pluginId, appId) => pluginId === 'com.duya.sample' && appId === 'counter'
            ? { appId, entry: 'apps/counter.html', requiredCapabilities: ['mcp:dashboard.read'], stateSchemaVersion: 1 }
            : null,
          resolveGrantedCapabilities: async () => ['mcp:dashboard.read'],
          resolveToolCapability: ({ descriptor }) =>
            descriptorMappingCurrent &&
            descriptor.source === 'plugin' && descriptor.serverName === 'dashboard' &&
              descriptor.toolName === 'read' && descriptor.pluginId === 'com.duya.sample'
              ? 'mcp:dashboard.read' : null,
        };
        const started = await startHostWithSession(root, await writeStubWorker(root, 'plugin-app'), authority);
        host = started.host;
        const { client, sessionId } = started;
        const instance = await client.createPluginAppInstance({
          pluginId: 'com.duya.sample', appId: 'counter', stateSchemaVersion: 1, state: {},
        });
        const run = await client.startAgentRun({ sessionId, prompt: 'keep the App invocation run active' });
        expect(run.accepted).toBe(true);
        if (!run.accepted) return;
        const binding = await client.bindPluginAppInvocation({
          pluginId: instance.pluginId, appId: instance.appId, instanceId: instance.instanceId, sessionId,
        });
        const invocation = client.invokePluginAppTool({
          bindingId: binding.bindingId,
          nonce: binding.nonce,
          toolId: 'mcp:server/dashboard.read',
          arguments: { query: 'status' },
        });
        let pending: readonly import('@duya/agent-protocol').HostPermissionRequest[] = [];
        const deadline = Date.now() + 5000;
        while (pending.length === 0 && Date.now() < deadline) {
          pending = await client.listPendingPermissionRequests(sessionId);
          if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pending).toHaveLength(1);
        if (pending.length === 0) return;
        if (decision === 'revoke') {
          await client.setPluginAppInstanceStatus(instance.instanceId, { expectedRevision: 1, status: 'revoked' });
        }
        if (decision === 'remap') descriptorMappingCurrent = false;
        const granted = decision !== 'deny';
        await client.resolvePermissionRequest(pending[0]!.id, {
          status: granted ? 'allow' : 'deny',
          decision: granted ? 'allow' : 'deny',
        });
        const result = await invocation;
        if (decision === 'allow') {
          expect(result).toMatchObject({ ok: true, result: { sideEffects: 1 } });
        } else {
          expect(result).toMatchObject({
            ok: false,
            code: decision === 'deny' ? 'tool_denied' : 'binding_revoked',
          });
        }
      } finally {
        await host?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

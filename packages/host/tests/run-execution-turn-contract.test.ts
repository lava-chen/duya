/**
 * run-execution-turn-contract.test.ts — the turn's configuration, measured on
 * the REAL `startAgentRun` path.
 *
 * ## Why this file exists
 *
 * `run-turn-overrides.test.ts` pins the rule. This file pins the PATH: a
 * request that names a permission mode, an effort, a profile and an
 * attachment has to arrive at the manifest the run row stores and at the
 * `chat:start` command the worker receives.
 *
 * The gap this closes is a real one, and it was found by tracing rather than
 * by reading: the manifest factory already understood every one of these
 * fields, and the run orchestrator already forwarded the turn's options to
 * the worker — but the CONTROLLER never filled them in. A caller could name
 * a permission mode on the start request and the run would be recorded under
 * `default`, which is the kind of quiet substitution that reads as "the
 * feature works" and is not.
 *
 * ## What is measured, and how
 *
 * A stub worker stands in for the real one. It does not answer a model
 * question: it ECHOES the `chat:start` command it was handed, so the test
 * can read the exact manifest and the exact options the Host dispatched. The
 * manifest is then also read back from the DURABLE run row, because the row
 * is what a reader of the run will see and a manifest that only exists in
 * the dispatch is not a record.
 *
 * The worker's echo is not a substitute for the real worker: it says what
 * the Host SENT. What the worker then does with it is the worker's lane, and
 * the last case below names the seam that has to be taken for the permission
 * mode to be applied rather than merely carried.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import type { RunId, SessionId } from '@duya/agent-protocol';

/**
 * A worker that echoes the `chat:start` command.
 *
 * It reports the manifest and the options it was given, and nothing else —
 * the point is to observe the dispatch, not to simulate a turn.
 */
const ECHO_WORKER_SOURCE = `
let activeRun = null;
let runSeq = 0;
let textIndex = 0;
function emitNative(payload) {
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
function emitText(text) {
  emitNative({
    type: 'assistant.text_block',
    messageId: activeRun.runId + ':message:1',
    index: textIndex++,
    text,
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
    if (command.type !== 'chat:start') continue;
    activeRun = {
      runId: command.runId,
      sessionId: command.sessionId,
      attemptEpoch: command.options && command.options.attemptEpoch,
    };
    runSeq = 0;
    textIndex = 0;
    emitNative({
      type: 'run.started',
      manifestHash: command.manifestHash,
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'echo-worker', version: '1.0.0' },
    });
    emitNative({
      type: 'turn.started',
      turnId: activeRun.runId + ':turn:1',
      index: 1,
      model: 'stub-model',
      providerId: 'stub-provider',
      apiFormat: 'anthropic',
    });
    emitText('echo=' + JSON.stringify({ manifest: command.manifest, options: command.options }));
    emitNative({
      type: 'turn.completed',
      turnId: activeRun.runId + ':turn:1',
      index: 1,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 1,
    });
    emitNative({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
    process.send({ type: 'chat:done', sessionId: command.sessionId });
  }
});
process.on('disconnect', () => process.exit(0));
`;

interface EchoedCommand {
  readonly manifest: {
    readonly permissionPolicy: { readonly mode: string; readonly hostSwitch: string };
    readonly agent: { readonly profileId: string | null; readonly model: string; readonly providerId: string; readonly effort?: string };
    readonly capabilities: { readonly profiles: readonly string[]; readonly modes: readonly string[]; readonly tools: readonly string[] };
    readonly budget: { readonly maxTurns?: number };
  };
  readonly options: Record<string, unknown>;
}

interface StartedHost {
  host: LocalHostHandle;
  client: HostSessionHttpClient;
  sessionId: string;
}

async function startHost(root: string, sessionIds: readonly string[] = []): Promise<StartedHost> {
  const dataRoot = path.join(root, 'data');
  const workerPath = path.join(root, 'stub-worker-echo.cjs');
  await fs.writeFile(workerPath, ECHO_WORKER_SOURCE, 'utf8');
  const host = await startLocalHost({
    dataRoot,
    databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: 'run-execution-turn-contract-token',
    workerPath,
    betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
  });
  const client = new HostSessionHttpClient(host.origin, 'run-execution-turn-contract-token');
  for (const sessionId of sessionIds) {
    await client.createImportedSession({
      sessionId: sessionId as SessionId,
      title: sessionId,
      workingDirectory: root,
      projectName: 'run-execution-turn-contract',
    });
  }
  return { host, client, sessionId: sessionIds[0] ?? '' };
}

async function collectEcho(
  client: HostSessionHttpClient,
  runId: string,
): Promise<EchoedCommand> {
  let echo: string | undefined;
  for await (const event of client.watchAgentRunEvents(runId as RunId)) {
    if (event.payload.type === 'assistant.text_block' && event.payload.text.startsWith('echo=')) {
      echo = event.payload.text;
    }
  }
  if (echo === undefined) throw new Error('the worker never echoed the command');
  return JSON.parse(echo.slice('echo='.length)) as EchoedCommand;
}

describe('a start request reaches the manifest and the worker', () => {
  it('records the requested permission mode, effort and profile, and hands them to the worker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-contract-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-contract']);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({
        sessionId,
        prompt: 'carry the turn configuration',
        model: 'test-model',
        providerId: 'local-test',
        permissionMode: 'acceptEdits',
        effort: 'high',
        agentProfileId: 'coder',
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      // The DURABLE row: what a reader of the run sees.
      const record = await client.getAgentRun(start.runId);
      expect(record?.manifest.permissionPolicy.mode).toBe('acceptEdits');
      expect(record?.manifest.agent.effort).toBe('high');
      expect(record?.manifest.agent.profileId).toBe('coder');
      expect(record?.manifest.capabilities.profiles).toEqual(['coder']);

      // The DISPATCH: what the worker was handed.
      const echo = await collectEcho(client, start.runId);
      expect(echo.manifest.permissionPolicy.mode).toBe('acceptEdits');
      expect(echo.manifest.agent.effort).toBe('high');
      expect(echo.options['permissionMode']).toBe('acceptEdits');
      expect(echo.options['effort']).toBe('high');
      expect(echo.options['agentProfileId']).toBe('coder');
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('carries the requested attachments to the worker in the carrier it already reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-attachments-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-attachments']);
      host = started.host;
      const { client, sessionId } = started;

      const attachments = [
        { id: 'file-1', name: 'notes.txt', type: 'text/plain', url: 'file:///notes.txt', size: 12, text: 'hello' },
      ];
      const start = await client.startAgentRun({
        sessionId,
        prompt: 'read the attachment',
        attachments,
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const echo = await collectEcho(client, start.runId);
      // The worker reads the turn's `files` and commits them onto the user
      // message, so that is where they have to be.
      expect(echo.options['files']).toEqual(attachments);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('records the declared modes, tools and rules on the manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-declared-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-declared']);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({
        sessionId,
        prompt: 'declare what the turn uses',
        model: 'test-model',
        providerId: 'local-test',
        modes: ['plan-task'],
        tools: ['read', 'bash'],
        permissionRules: { workspace: ['read'] },
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const record = await client.getAgentRun(start.runId);
      expect(record?.manifest.capabilities.modes).toEqual(['plan-task']);
      expect(record?.manifest.capabilities.tools).toEqual(['read', 'bash']);
      expect(record?.manifest.permissionPolicy.rules).toEqual({ workspace: ['read'] });
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not let the bag state the host switch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-switch-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-switch']);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({
        sessionId,
        prompt: 'try to move the host switch',
        options: { hostSwitch: 'always' },
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const record = await client.getAgentRun(start.runId);
      // The switch is the Host's standing configuration, and there is no
      // configuration source for it yet, so it is 'ask'.
      expect(record?.manifest.permissionPolicy.hostSwitch).toBe('ask');

      const echo = await collectEcho(client, start.runId);
      expect(echo.options).not.toHaveProperty('hostSwitch');
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('REFUSES a permission mode the protocol does not have, and starts nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-invalid-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-invalid']);
      host = started.host;
      const { client, sessionId } = started;

      // 'auto' is the AGENT's vocabulary. A caller that sends it must be
      // told, not silently given 'default'.
      await expect(
        client.startAgentRun({
          sessionId,
          prompt: 'run under a mode that does not exist',
          permissionMode: 'auto' as never,
        }),
      ).rejects.toThrow();

      const runs = await client.listAgentRunsBySession(sessionId);
      expect(runs).toEqual([]);
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not let the free option bag state the permission mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-bag-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root, ['sess-turn-bag']);
      host = started.host;
      const { client, sessionId } = started;

      const start = await client.startAgentRun({
        sessionId,
        prompt: 'try to state the mode in the bag',
        options: { permissionModeOverride: 'bypassPermissions' },
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const record = await client.getAgentRun(start.runId);
      // The session's own mode is 'default', so the run is recorded under it.
      expect(record?.manifest.permissionPolicy.mode).toBe('default');

      const echo = await collectEcho(client, start.runId);
      // The legacy agent-space override is GONE: it is the one key that let
      // a caller set the mode the worker applies without the Host deciding.
      expect(echo.options).not.toHaveProperty('permissionModeOverride');
      expect(echo.options['permissionMode']).toBe('default');
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a child session is held to the mode it inherited', () => {
  it('refuses to run wider than the parent session it was spawned into', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-child-'));
    let host: LocalHostHandle | undefined;
    try {
      const started = await startHost(root);
      host = started.host;
      const { client } = started;

      const parentId = 'sess-turn-parent';
      const childId = 'sess-turn-child';
      await client.create({
        id: parentId as SessionId,
        title: 'parent',
        permissionMode: 'default',
      });
      // A spawned session INHERITS its parent's permission mode, and that
      // inherited mode is the limit for the child's turns.
      await client.create({
        id: childId as SessionId,
        title: 'child',
        permissionMode: 'default',
        parentSessionId: parentId as SessionId,
      });

      const start = await client.startAgentRun({
        sessionId: childId,
        prompt: 'ask for more than the parent allows',
        permissionMode: 'bypassPermissions',
      });
      expect(start.accepted).toBe(true);
      if (!start.accepted) return;

      const record = await client.getAgentRun(start.runId);
      // The parent asked for 'default'; the child cannot buy its way past it.
      expect(record?.manifest.permissionPolicy.mode).toBe('default');

      const echo = await collectEcho(client, start.runId);
      expect(echo.options['permissionMode']).toBe('default');
    } finally {
      await host?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

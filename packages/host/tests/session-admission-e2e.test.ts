/**
 * session-admission-e2e.test.ts — the unified admission path, measured on the
 * REAL worker.
 *
 * ## Why this file exists
 *
 * `session-admission.test.ts` proves the CLASSIFIER maps a Control Plane
 * stage onto the right session stage. It does not prove that anything ever
 * reaches the classifier, and it does not prove that a turn admitted through
 * the unified path actually arrives at the engine.
 *
 * That is the gap this migration exists to close. The R1.0 audit found FOUR
 * entry points that each started a run their own way, and the admission
 * preconditions had TWO strengths. A classifier that is correct but never
 * called would leave both facts true, and the test suite would be green.
 *
 * So this file starts a REAL worker from the PRODUCTION bundle, drives a turn
 * through the unified entry, and asserts:
 *
 * 1. The turn reached the engine — the scripted provider saw the prompt.
 * 2. The run reached a durable terminal.
 * 3. A refusal for a session that does not exist is refused with the
 *    session-specific stage, not a generic one.
 *
 * ## The bundle is an input, not a build artifact
 *
 * The worker runs from the committed bundle, so this test needs that bundle
 * to be current. `npm run bundle:worker` rebuilds it and `npm run
 * bundle:verify` (a CI gate) fails when it is stale.
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const roots: string[] = [];
const savedDataRoot = process.env.DUYA_DATA_ROOT;
const savedTestMode = process.env.DUYA_TEST;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  if (savedDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
  else process.env.DUYA_DATA_ROOT = savedDataRoot;
  if (savedTestMode === undefined) delete process.env.DUYA_TEST;
  else process.env.DUYA_TEST = savedTestMode;
});

/** One Anthropic text block, as the endpoint streams it. */
function textStream(text: string, round: number): string {
  const events = [
    { type: 'message_start', message: { id: `msg-${round}`, type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A scripted Anthropic endpoint that records the raw request bodies.
 *
 * The raw body is the evidence: it is the only place the turn's prompt is
 * observable after it has passed through admission, dispatch and the worker's
 * own context assembly.
 */
async function startScriptedProvider(): Promise<{
  readonly origin: string;
  readonly requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    try {
      const raw = await readRequest(request);
      requests.push(raw);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.end(textStream('ADMISSION_E2E_TEXT', requests.length));
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

interface Harness {
  readonly host: LocalHostHandle;
  readonly client: HostSessionHttpClient;
  readonly provider: { readonly origin: string; readonly requests: string[]; close(): Promise<void> };
  readonly sessionId: SessionId;
}

/**
 * A Host on a temporary data root, a scripted provider behind it, and one
 * imported session.
 *
 * The worker runs from the PRODUCTION bundle: a worker built from source
 * would test a different artifact than the one that ships.
 */
async function startHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-admission-e2e-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const provider = await startScriptedProvider();
  delete process.env.DUYA_TEST;
  process.env.DUYA_DATA_ROOT = root;
  await fs.writeFile(path.join(root, 'config.toml'),
    `[model]\nprovider = "local-test"\ndefault = "test-model"\n\n` +
    `[providers.local-test]\nproviderType = "anthropic"\nbaseUrl = "${provider.origin}"\n\n` +
    `[providers.local-test.options]\ndefaultModel = "test-model"\n`, 'utf8');
  await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.local-test.apiKey': 'admission-e2e-key' }), 'utf8');

  const productionWorkerPath = path.resolve(process.cwd(), 'packages/host/bundle/worker-entry.js');
  await fs.access(productionWorkerPath);
  // Vitest marks its own process with VITEST. The fork inherits that marker,
  // which makes the production DB client correctly reject the pool's
  // process.send channel. Clear only the runner marker before loading the real
  // bundled worker so its DB bridge uses the actual fork IPC transport.
  const workerPath = path.join(root, 'worker-entry-test-wrapper.cjs');
  await fs.writeFile(workerPath,
    `delete process.env.VITEST;\nrequire(${JSON.stringify(productionWorkerPath)});\n`, 'utf8');

  const host = await startLocalHost({
    dataRoot: root,
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    runtimeFilePath: path.join(root, 'runtime', 'host-api.json'),
    port: 0,
    token: 'admission-e2e-token',
    workerPath,
    betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
    ephemeral: true,
  });
  const client = new HostSessionHttpClient(host.origin, 'admission-e2e-token');
  const sessionId = 'sess-admission-e2e' as SessionId;
  await client.createImportedSession({ sessionId, title: 'admission e2e', workingDirectory: workspace, projectName: 'admission-e2e' });
  return { host, client, provider, sessionId };
}

/**
 * Wait for the run to finish.
 *
 * The run record is written when the run is DISPATCHED, so reading it right
 * after the start returns `running`; the terminal lands when the worker
 * reports the turn's end. Draining the event stream is what waits for that.
 */
async function drainRun(client: HostSessionHttpClient, runId: string): Promise<void> {
  for await (const _event of client.watchAgentRunEvents(runId as never)) {
    // The stream ends when the run reaches a terminal state.
  }
}

describe('unified admission — the real worker', () => {
  it('carries a turn admitted through the unified path into the engine', { timeout: 120_000 }, async () => {
    const { host, client, provider, sessionId } = await startHarness();
    try {
      const started = await client.startAgentRun({
        sessionId,
        prompt: 'ADMISSION_E2E_PROMPT_MARKER',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
        permissionMode: 'bypassPermissions',
      });

      // The admission answer is the unified one: accepted, and a run id.
      expect(started.accepted).toBe(true);
      if (!started.accepted) return;

      await drainRun(client, started.runId);

      // The run reached a DURABLE terminal, not just "the dispatch happened".
      const run = await client.getAgentRun(started.runId);
      expect(run?.status, JSON.stringify(run)).toBe('completed');

      // And the turn actually reached the model — which is the only way to
      // know the admission path reached the engine rather than stopping at
      // the ledger.
      const seen = provider.requests.some((raw) => raw.includes('ADMISSION_E2E_PROMPT_MARKER'));
      expect(seen, 'the provider never saw the prompt, so the turn never reached the engine').toBe(true);
    } finally {
      await provider.close();
      await host.close();
    }
  });

  it('refuses a session that does not exist with the session-specific stage', { timeout: 120_000 }, async () => {
    const { host, client, provider } = await startHarness();
    try {
      const started = await client.startAgentRun({
        sessionId: 'sess-does-not-exist' as SessionId,
        prompt: 'ADMISSION_E2E_MISSING_SESSION',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
      });

      expect(started.accepted).toBe(false);
      if (started.accepted) return;
      // The stage says WHICH refusal it was, so the caller does not have to
      // parse the reason to learn that the session is missing.
      expect(started.stage).toBe('refused_no_session');
      // A refused admission dispatches nothing, so the provider was never
      // called for this turn.
      expect(provider.requests.some((raw) => raw.includes('ADMISSION_E2E_MISSING_SESSION'))).toBe(false);
    } finally {
      await provider.close();
      await host.close();
    }
  });
});

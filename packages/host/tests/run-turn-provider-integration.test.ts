/**
 * run-turn-provider-integration.test.ts — the turn's configuration, measured on
 * the REAL worker and the REAL provider request.
 *
 * ## Why this file exists
 *
 * `run-execution-turn-contract.test.ts` measures the Host's side: a stub worker
 * echoes the `chat:start` command, so the test sees exactly what the Host
 * dispatched. That is the right boundary for "did the Host decide this?", and
 * the wrong boundary for "did the DECISION reach the model?".
 *
 * A turn's effort and its attachments both have a second hop, and that hop is
 * where a contract quietly dies:
 *
 *   effort     → manifest.agent.effort → dispatch options → worker chatOptions
 *              → provider `thinking.budget_tokens`
 *   attachment → dispatch options.files → worker chatOptions.attachments
 *              → the attachment context message → the provider's messages
 *
 * Every link in those two chains belongs to a different file, and a link that
 * is never exercised is a link that does not exist. This file exercises them
 * against the PRODUCTION worker bundle (`packages/host/bundle/worker-entry.js`)
 * and a scripted Anthropic endpoint, so the assertions are about bytes on the
 * wire rather than about objects in the Host's memory.
 *
 * ## What the effort assertions actually prove
 *
 * The Anthropic client derives `thinking.budget_tokens` from the effort level
 * (`packages/ai/src/api/anthropic-messages.ts`, `resolveAnthropicThinking`),
 * and it clamps that budget to the request's own `max_tokens`. So the expected
 * value is a function of the request that was actually sent, not a constant:
 * `min(budget(level), max_tokens - 1)`. The assertions below compute it that
 * way, which keeps them true whether the worker sends 4096 or 8192.
 *
 * A "low" run and an unset-effort run produce DIFFERENT budgets, and that
 * difference is the evidence: an effort that never reached the provider would
 * leave both requests identical.
 *
 * ## The bundle is an input, not a build artifact
 *
 * The worker runs from the committed bundle, so this test needs that bundle to
 * be current. `npm run bundle:agent` rebuilds it; `npm run bundle:verify` (a
 * CI gate) fails when it is stale. A failure here that looks like "the Host
 * dropped my effort" is, on a stale bundle, exactly what a stale bundle looks
 * like.
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const roots: string[] = [];
const savedDataRoot = process.env.DUYA_DATA_ROOT;
const savedTestMode = process.env.DUYA_TEST;

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
  else process.env.DUYA_DATA_ROOT = savedDataRoot;
  if (savedTestMode === undefined) delete process.env.DUYA_TEST;
  else process.env.DUYA_TEST = savedTestMode;
  for (const root of roots.splice(0)) {
    // The worker holds the SQLite file open for a moment after the Host
    // closes, and Windows refuses to unlink a locked file. `maxRetries` is
    // the documented way to wait that out; without it the cleanup fails and
    // the TEST fails, which reads as "the contract broke" when nothing broke.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

interface ScriptedRequest {
  readonly maxTokens: number | undefined;
  readonly thinking: { readonly type?: string; readonly budget_tokens?: number } | undefined;
  readonly messages: readonly { readonly role?: unknown; readonly content?: unknown }[];
  readonly raw: string;
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

function textStream(text: string, id: string): string {
  const events = [
    { event: 'message_start', data: { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A scripted Anthropic endpoint that records the RAW request bodies.
 *
 * The raw body matters: `thinking.budget_tokens` is computed inside the client
 * and never surfaces as a Host-side object, so the request is the only place
 * it can be observed.
 */
async function startScriptedProvider(script?: (round: number) => string): Promise<{
  readonly origin: string;
  readonly requests: ScriptedRequest[];
  close(): Promise<void>;
}> {
  const requests: ScriptedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    try {
      const raw = await readRequest(request);
      const payload = JSON.parse(raw) as {
        messages?: { role?: unknown; content?: unknown }[];
        max_tokens?: number;
        thinking?: { type?: string; budget_tokens?: number };
      };
      requests.push({
        maxTokens: payload.max_tokens,
        thinking: payload.thinking,
        messages: payload.messages ?? [],
        raw,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.end(script?.(requests.length) ?? textStream('SCRIPTED_FINAL_TEXT', String(requests.length)));
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

/**
 * Wait for the run to finish.
 *
 * Reading the run record straight after the start returns `running`: the
 * record is written when the run is DISPATCHED, and the terminal state lands
 * when the worker reports the turn's end. Draining the event stream is what
 * waits for that.
 */
async function drainRun(client: HostSessionHttpClient, runId: string): Promise<void> {
  for await (const _event of client.watchAgentRunEvents(runId as never)) {
    // The stream ends when the run reaches a terminal state.
  }
}

interface Harness {
  readonly host: LocalHostHandle;
  readonly client: HostSessionHttpClient;
  readonly provider: { readonly origin: string; readonly requests: ScriptedRequest[]; close(): Promise<void> };
  readonly sessionId: SessionId;
  readonly workspace: string;
}

/**
 * A Host on a temporary data root, a scripted provider behind it, and one
 * imported session.
 *
 * The worker runs from the PRODUCTION bundle, not from the source tree: the
 * bundle is what the product ships, and a worker built from source would test
 * a different artifact than the one that runs.
 */
async function startHarness(script?: (round: number) => string): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-turn-provider-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const provider = await startScriptedProvider(script);
  delete process.env.DUYA_TEST;
  process.env.DUYA_DATA_ROOT = root;
  await fs.writeFile(path.join(root, 'config.toml'),
    `[model]\nprovider = "local-test"\ndefault = "test-model"\n\n` +
    `[providers.local-test]\nproviderType = "anthropic"\nbaseUrl = "${provider.origin}"\n\n` +
    `[providers.local-test.options]\ndefaultModel = "test-model"\n`, 'utf8');
  await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.local-test.apiKey': 'turn-provider-test-key' }), 'utf8');

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
    token: 'turn-provider-test-token',
    workerPath,
    betterSqlite3Path: path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
    ephemeral: true,
  });
  const client = new HostSessionHttpClient(host.origin, 'turn-provider-test-token');
  const sessionId = 'sess-turn-provider-contract' as SessionId;
  await client.createImportedSession({ sessionId, title: 'turn provider contract', workingDirectory: workspace, projectName: 'turn-contract' });
  return { host, client, provider, sessionId, workspace };
}

/** The budget the Anthropic client derives from an effort level. */
function expectedBudget(effort: 'low' | 'medium' | 'high', maxTokens: number | undefined): number {
  const table: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
  const budget = table[effort] as number;
  // The client clamps twice: once to the model's own ceiling and once to the
  // request's `max_tokens`. The model's ceiling (8192) is above every budget
  // used here, so only the request clamp is observable.
  return Math.min(budget, (maxTokens ?? 4096) - 1);
}

describe('Host turn input contract — production worker and provider', () => {
  // A real worker doing three real git operations (worktree add, write,
  // worktree remove). 180s keeps slow CI runners out of the picture; the
  // macos CI hang documented in plan 621 is not a timeout-budget problem
  // (it outlived 180s) and needs its own investigation.
  it('enters a worktree, writes there and exits through the production worker', { timeout: 180_000 }, async () => {
    const toolStream = (round: number, name: string, input: Record<string, unknown>): string => {
      const events = [
        { type: 'message_start', message: { id: `msg-${round}`, type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${round}`, name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    };
    const { host, client, provider, sessionId, workspace } = await startHarness((round) =>
      round === 1 ? toolStream(round, 'enter_worktree', { name: 'real-worker' })
      : round === 2 ? toolStream(round, 'write', { file_path: 'worker-result.txt', content: 'REAL_WORKER_CHECKOUT_RESULT' })
      : round === 3 ? toolStream(round, 'exit_worktree', { disposition: 'keep' })
      : textStream('WORKTREE_ROUNDTRIP_COMPLETE', String(round)));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@duya.local'); git('config', 'user.name', 'Duya test');
      await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'TARGET_COMMITTED_INSTRUCTIONS');
      git('add', '.'); git('commit', '-qm', 'initial');
      await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'SOURCE_DIRTY_INSTRUCTIONS');
      const started = await client.startAgentRun({ sessionId, prompt: 'WORKTREE_REAL_PROCESS_PROBE', model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic', permissionMode: 'bypassPermissions', options: { maxTurns: 6 } });
      expect(started.accepted).toBe(true);
      if (!started.accepted) return;
      await drainRun(client, started.runId);
      const run = await client.getAgentRun(started.runId);
      expect(run?.status, JSON.stringify(run)).toBe('completed');
      const nextRound = provider.requests[1];
      expect(nextRound?.raw).toContain('TARGET_COMMITTED_INSTRUCTIONS');
      const entered = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))[1]!.slice(9);
      expect(await fs.readFile(path.join(entered, 'worker-result.txt'), 'utf8')).toBe('REAL_WORKER_CHECKOUT_RESULT');
      await expect(fs.access(path.join(workspace, 'worker-result.txt'))).rejects.toThrow();
      expect((await client.controlSessionCheckout(sessionId, { action: 'status' })).state.cwd).toBe(workspace);
      // Auxiliary provider calls may follow the four main model rounds.
      expect(provider.requests.length).toBeGreaterThanOrEqual(4);
    } finally { await provider.close(); await host.close(); }
  });

  it('carries the requested effort into the next real provider request', async () => {
    const { host, client, provider, sessionId } = await startHarness();
    try {
      const low = await client.startAgentRun({
        sessionId,
        prompt: 'CONTRACT_EFFORT_LOW: say nothing useful.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
        effort: 'low',
      });
      expect(low.accepted).toBe(true);
      if (!low.accepted) return;
      await drainRun(client, low.runId);

      const run = await client.getAgentRun(low.runId);
      expect(run?.status, JSON.stringify({ status: run?.status, terminal: run?.terminal })).toBe('completed');
      // The manifest is the run's record of how it was configured.
      expect(run?.manifest.agent?.effort).toBe('low');

      const unset = await client.startAgentRun({
        sessionId,
        prompt: 'CONTRACT_EFFORT_UNSET: say nothing useful.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
      });
      expect(unset.accepted).toBe(true);
      if (!unset.accepted) return;
      await drainRun(client, unset.runId);
      expect((await client.getAgentRun(unset.runId))?.status).toBe('completed');

      const lowRequest = provider.requests.find((request) => request.raw.includes('CONTRACT_EFFORT_LOW'));
      const unsetRequest = provider.requests.find((request) => request.raw.includes('CONTRACT_EFFORT_UNSET'));
      expect(lowRequest, 'the provider never saw the low-effort turn').toBeDefined();
      expect(unsetRequest, 'the provider never saw the unset-effort turn').toBeDefined();
      if (lowRequest === undefined || unsetRequest === undefined) return;

      // The Anthropic client always enables thinking, so the effort level is
      // observable as the thinking budget.
      expect(lowRequest.thinking?.type).toBe('enabled');
      expect(lowRequest.thinking?.budget_tokens).toBe(expectedBudget('low', lowRequest.maxTokens));
      expect(unsetRequest.thinking?.budget_tokens).toBe(expectedBudget('medium', unsetRequest.maxTokens));
      // The whole point: the two requests differ because of the effort, not
      // because of anything else the runs had in common.
      expect(lowRequest.thinking?.budget_tokens).not.toBe(unsetRequest.thinking?.budget_tokens);
    } finally {
      await provider.close();
      await host.close();
    }
  }, 60_000);

  it('carries the requested attachment into the provider turn input', async () => {
    const { host, client, provider, sessionId, workspace } = await startHarness();
    try {
      const attachmentPath = path.join(workspace, 'contract-notes.txt');
      await fs.writeFile(attachmentPath, 'CONTRACT_ATTACHMENT_MARKER\n', 'utf8');

      const started = await client.startAgentRun({
        sessionId,
        prompt: 'CONTRACT_ATTACHMENT_TURN: read the attached notes.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
        attachments: [{
          id: 'contract-attachment-1',
          kind: 'file',
          name: 'contract-notes.txt',
          type: 'text/plain',
          url: attachmentPath,
          size: 25,
          path: attachmentPath,
          text: 'CONTRACT_ATTACHMENT_MARKER',
        }],
      });
      expect(started.accepted).toBe(true);
      if (!started.accepted) return;
      await drainRun(client, started.runId);
      expect((await client.getAgentRun(started.runId))?.status).toBe('completed');

      const request = provider.requests.find((candidate) => candidate.raw.includes('CONTRACT_ATTACHMENT_TURN'));
      expect(request, 'the provider never saw the attachment turn').toBeDefined();
      if (request === undefined) return;

      const promptText = request.messages.map((message) => textOf(message.content)).join('\n');
      expect(promptText).toContain('CONTRACT_ATTACHMENT_MARKER');
      // The attachment travels through the EXISTING attachment context: a
      // hidden runtime-context message, not a new channel of its own.
      expect(promptText).toContain('[System Parsed File]');
      expect(promptText).toContain('contract-notes.txt');
    } finally {
      await provider.close();
      await host.close();
    }
  }, 60_000);

  it('refuses an invalid turn override instead of running the turn under a default', async () => {
    const { host, client, provider, sessionId } = await startHarness();
    try {
      await expect(client.startAgentRun({
        sessionId,
        prompt: 'CONTRACT_INVALID_MODE: this turn must not run.',
        model: 'test-model',
        providerId: 'local-test',
        apiFormat: 'anthropic',
        permissionMode: 'auto' as never,
      })).rejects.toThrow();

      // A refused turn never reaches the provider.
      expect(provider.requests.some((request) => request.raw.includes('CONTRACT_INVALID_MODE'))).toBe(false);
    } finally {
      await provider.close();
      await host.close();
    }
  }, 60_000);
});


function truncatedStream(includeTool = false): string {
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { id: 'truncated', type: 'message', role: 'assistant', content: [], model: 'test-model', usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'unfinished reasoning' } },
    { type: 'content_block_stop', index: 0 },
  ];
  if (includeTool) events.push(
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'clipped-tool', name: 'write', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"must-not-exist.txt","content":"partial"}' } },
    { type: 'content_block_stop', index: 1 },
  );
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  );
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('output truncation through the production Host and worker', () => {
  it.each([false, true])('continues without user input and drops clipped tools (tool=%s)', async includeTool => {
    const { host, client, provider, sessionId, workspace } = await startHarness(round => round === 1 ? truncatedStream(includeTool) : textStream('RECOVERED_FINAL_ANSWER', String(round)));
    try {
      const started = await client.startAgentRun({ sessionId, prompt: 'CONTRACT_TRUNCATION: finish the task', model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic' });
      expect(started.accepted).toBe(true);
      if (!started.accepted) throw new Error('run refused');
      const events = [];
      for await (const event of client.watchAgentRunEvents(started.runId)) events.push(event);
      expect((await client.getAgentRun(started.runId))?.status).toBe('completed');
      // Title and next-step suggestion requests use their own smaller budgets.
      const turnRequests = provider.requests.filter(request => request.maxTokens === 32_768);
      expect(turnRequests).toHaveLength(2);
      expect(turnRequests[0]?.raw).toContain('CONTRACT_TRUNCATION');
      expect(turnRequests[1]?.raw).toContain('previous response reached its output token limit');
      const eventText = JSON.stringify(events);
      expect(eventText).toContain('RECOVERED_FINAL_ANSWER');
      expect(eventText).toContain('continuing automatically');
      expect(eventText).not.toContain('"type":"tool.call_started"');
      await expect(fs.access(path.join(workspace, 'must-not-exist.txt'))).rejects.toThrow();
    } finally {
      await host.close();
      await provider.close();
    }
  }, 60_000);

  it('makes exhaustion visible instead of marking a thinking-only run completed', async () => {
    const { host, client, provider, sessionId } = await startHarness(() => truncatedStream());
    try {
      const started = await client.startAgentRun({ sessionId, prompt: 'CONTRACT_TRUNCATION_EXHAUST: finish', model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic' });
      if (!started.accepted) throw new Error('run refused');
      await drainRun(client, started.runId);
      const run = await client.getAgentRun(started.runId);
      expect(run?.status).toBe('failed');
      expect(JSON.stringify(run)).toContain('output token limit');
      expect(provider.requests).toHaveLength(4);
    } finally {
      await host.close();
      await provider.close();
    }
  }, 60_000);
});

it('executes private progress and accounts cached input through the real worker', async () => {
  const progressStream = () => [
    { type: 'message_start', message: { id: 'progress', type: 'message', role: 'assistant', content: [], model: 'test-model', usage: { input_tokens: 0, cache_read_input_tokens: 12000, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'progress-call', name: 'progress_update', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ title: 'Inspect provider settings' }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const { host, client, provider, sessionId } = await startHarness(round => round === 1 ? progressStream() : textStream('PROGRESS_FINISHED', String(round)));
  try {
    const started = await client.startAgentRun({ sessionId, prompt: 'CONTRACT_PROGRESS: inspect settings', model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic' });
    if (!started.accepted) throw new Error('run refused');
    const events = [];
    for await (const event of client.watchAgentRunEvents(started.runId)) events.push(event);
    expect((await client.getAgentRun(started.runId))?.status).toBe('completed');
    const rendered = JSON.stringify(events);
    expect(rendered).toContain('Inspect provider settings');
    expect(rendered).toContain('tool.group_progress');
    expect(rendered).toContain('"inputTokens":12000');
    expect(rendered).not.toContain('No such tool');
    const requests = provider.requests.filter(request => request.maxTokens === 32768);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.raw).toContain('progress_update');
    expect(requests[1]?.raw).toContain('Progress updated');
    expect(rendered).toContain('PROGRESS_FINISHED');
  } finally {
    await host.close();
    await provider.close();
  }
}, 60000);

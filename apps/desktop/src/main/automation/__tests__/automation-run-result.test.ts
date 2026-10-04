/**
 * Plan 587 H8.2 — automation settles on the run layer's `RunResult`.
 *
 * ## What is under test
 *
 * `runPromptInSession` used to resolve the moment the worker's SSE `done` frame
 * arrived. That frame is the executor saying "I stopped emitting"; it is not
 * the run's verdict. The plan asks automation to read the `RunResult` instead,
 * and this file is the evidence that it does — and that the difference is
 * observable rather than cosmetic.
 *
 * ## Why a real socket
 *
 * `readRunResult` is the thing being asserted, and it is a network read. A test
 * that stubbed the HTTP layer would be asserting that a mock was called. So
 * this file starts a real `http.Server` on an ephemeral port, points
 * `getAgentServerPort` at it, and lets the production client talk to it over a
 * real TCP connection. Both the SSE POST and the `run-result` GET cross that
 * socket for real.
 *
 * ## The falsifiable core
 *
 * Every test here sends a `done` frame — the frame the OLD code settled on. The
 * outcome is then decided entirely by the `RunResult` the fake Control Plane
 * serves. A `budget_exhausted` run therefore has to REJECT, where the old
 * implementation resolved with the streamed text and reported success. That is
 * the claim, and it is the one that would fail if the change were reverted.
 *
 * ## What is NOT crossed
 *
 * No worker process, no provider, no Electron, and no SQLite. The `RunResult`
 * served here is a fixture: it stands in for what `handleGetRunResult` reads
 * out of a real orchestrator. That read path is covered for real, on a real
 * `RunController`, in `apps/desktop/src/main/__tests__/run-result-read.test.ts`.
 * Between the two files the whole chain is real except the HTTP hop's server
 * side, which is the one seam a unit test is allowed to fake.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { RunPromptInSessionOptions } from '../agent-run';
import { runPromptInSession } from '../agent-run';

const mocks = vi.hoisted(() => ({
  port: 0 as number,
}));

// The module under test reaches for Electron (for the threads-changed
// broadcast), the agent server's port, the core DB, and the compaction
// config. None of them are on the path this file asserts, and all four would
// otherwise need a real host. `vi.mock` paths are relative to THIS file.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../agents/agent-server-lifecycle', () => ({
  getAgentServerPort: () => mocks.port,
}));

vi.mock('../../db/core-connection', () => ({
  getCoreStores: () => ({ sessions: { get: () => undefined } }),
}));

vi.mock('../compact-config', () => ({
  resolveCompactModelConfig: () => null,
}));

/** The verdict the fake Control Plane will serve for the run. */
type ServedStatus = 'completed' | 'cancelled' | 'budget_exhausted' | 'failed' | 'absent' | 'garbage';

let server: Server;
/** Requests the client made, so the file can assert it really read the result. */
let requests: Array<{ method: string; url: string; body: string }>;
let served: { status: ServedStatus; runId: string };

const RUN_ID = 'run-fixture-1';

function sseFrame(type: string, data?: unknown): string {
  return `data: ${JSON.stringify(data === undefined ? { type } : { type, data })}\n\n`;
}

const serverHandler = (req: IncomingMessage, res: ServerResponse): void => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', body });

    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // A turn that streamed text and then finished normally, from the
      // worker's point of view. This is the frame the old code settled on.
      res.write(sseFrame('text', { content: 'hello from the worker' }));
      res.write(sseFrame('done'));
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url ?? '').endsWith('/run-result')) {
      if (served.status === 'absent') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: null, run: null }));
        return;
      }
      if (served.status === 'garbage') {
        // A body that is present but carries a terminal outside the known
        // vocabulary. The reader must refuse it rather than believe it.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: RUN_ID, run: { runId: RUN_ID, status: 'exploded' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          runId: RUN_ID,
          run: {
            runId: RUN_ID,
            sessionId: 'session-1',
            status: served.status,
            metrics: { turns: 1 },
            budgetUsed: { tokens: { limit: null, spent: 0, unknown: false } },
            transcript: { kind: 'unsupported' },
            permissionAudit: { kind: 'unsupported' },
          },
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
};

beforeAll(async () => {
  server = createServer(serverHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mocks.port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  requests = [];
  served = { status: 'completed', runId: RUN_ID };
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseOpts: RunPromptInSessionOptions = {
  sessionId: 'session-1',
  prompt: 'do the thing',
  workingDirectory: '/repo',
  providerConfig: { apiKey: 'k', model: 'claude-opus', provider: 'p', authStyle: 'api_key' },
};

describe('H8.2 — automation reads the RunResult instead of trusting the done frame', () => {
  it('resolves a completed run and reports the RunResult it read', async () => {
    const result = await runPromptInSession(baseOpts);

    // The streamed text is still delivered verbatim — the transport did not
    // change. What changed is the authority on whether it counts as success.
    expect(result.output).toBe('hello from the worker');
    expect(result.run?.status).toBe('completed');
    expect(result.run?.runId).toBe(RUN_ID);
  });

  it('really issues the run-result read, as a bodiless GET', async () => {
    await runPromptInSession(baseOpts);

    const reads = requests.filter((r) => r.url.endsWith('/run-result'));
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe('GET');
    // A read carries no decision of its own. This is the shape of the
    // permission/budget argument: the client cannot grant, allow or raise a
    // ceiling on this hop, it can only read back what the run layer decided.
    expect(reads[0].body).toBe('');
  });

  it('fails a budget-exhausted run that the worker still called done', async () => {
    // The falsifiable core. The worker emitted a perfectly ordinary `done`
    // frame; the run layer stopped on its ceiling. Under the old settlement
    // this resolved with the streamed text and the scheduler recorded a
    // successful wake.
    served.status = 'budget_exhausted';

    await expect(runPromptInSession(baseOpts)).rejects.toThrow(/budget/i);
  });

  it('fails a cancelled run that the worker still called done', async () => {
    served.status = 'cancelled';

    await expect(runPromptInSession(baseOpts)).rejects.toThrow(/cancelled/i);
  });

  it('fails a failed run that the worker still called done', async () => {
    served.status = 'failed';

    await expect(runPromptInSession(baseOpts)).rejects.toThrow(/failed/i);
  });

  it('fails when the run layer cannot produce a receipt, rather than trusting the frame', async () => {
    // Contract §C: a durable consumer refuses an unconfirmed success. The
    // `done` frame arrived; with no `RunResult` there is nothing to confirm,
    // so this rejects instead of reporting the frame's opinion as success.
    served.status = 'absent';

    await expect(runPromptInSession(baseOpts)).rejects.toThrow(/no RunResult|cannot be confirmed/i);
  });

  it('refuses a receipt whose terminal it cannot read, instead of believing it', async () => {
    // The read narrows the body rather than casting it, so a terminal outside
    // the known vocabulary is "no receipt" rather than a success. This is the
    // fail-closed direction: a protocol change must not be able to turn into
    // a silent wake.
    served.status = 'garbage';

    await expect(runPromptInSession(baseOpts)).rejects.toThrow(/no RunResult|cannot be confirmed/i);
  });

  it('does not turn a non-2xx chat response into a success', async () => {
    // The pre-existing guard, kept green: a refused turn still rejects.
    const failing = createServer((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session is streaming' }));
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const port = mocks.port;
    mocks.port = (failing.address() as AddressInfo).port;
    try {
      await expect(runPromptInSession(baseOpts)).rejects.toThrow(/409/);
    } finally {
      mocks.port = port;
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});

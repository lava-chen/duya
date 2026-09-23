import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { ChildProcess } from 'child_process';
import { createHandleRequest, type RouterDeps } from '../router';
import { SessionManager } from '../session-store';

/**
 * Plan 560 §5.2: the run-anchored HTTP surface.
 *
 * These are real requests against a real server, because the contract that
 * matters here is the wire shape — status codes, and above all the SSE framing
 * plus the `?afterSeq=` replay. Phase 4 renders straight off this stream, so a
 * bug in the frame shape would only show up as an empty run card.
 *
 * `WorkflowRuntimeManager` is faked: its own behaviour is covered by
 * workflow-runtime-manager.test.ts. What is under test here is the routing, the
 * provider resolution and the two replay sources (live manager vs past run).
 */

const ROW = {
  id: 'run-1',
  workflowName: 'digest',
  status: 'complete',
  createdAt: 1000,
  updatedAt: 2000,
  finishedAt: 2000,
  spentTokens: 42,
  pauseMessage: null,
  artifacts: [{ id: 'a1', name: 'report.md', contentType: 'text/markdown', bytes: 5, relPath: 'run-1/report.md' }],
};

interface Harness {
  url: string;
  close: () => Promise<void>;
  dbRequest: ReturnType<typeof vi.fn>;
  runtime: {
    trigger: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    listRuns: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    resolvePermission: ReturnType<typeof vi.fn>;
    /** Frames the SSE route registered, when `attach` accepted the run. */
    push: (frame: Record<string, unknown>) => void;
    detached: () => boolean;
  };
}

function silent() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function startServer(options: { withRuntime?: boolean; attach?: boolean } = {}): Promise<Harness> {
  const { withRuntime = true, attach = false } = options;

  const dbRequest = vi.fn(async (action: string, _payload: Record<string, unknown>): Promise<unknown> => {
    switch (action) {
      case 'config:provider:getActive':
        return { id: 'p1', apiKey: 'k', baseUrl: 'http://llm.test', providerType: 'openai', options: { defaultModel: 'm1' } };
      case 'workflowRun:get':
        return ROW;
      case 'workflowRun:listEvents':
        return [
          { seq: 0, kind: 'phase', nodeId: 'p0', attempt: 1, status: 'running', action: 'collect' },
          { seq: 1, kind: 'node_result', nodeId: 'n1', attempt: 1, status: 'succeeded', action: 'tool:Bash' },
        ];
      default:
        return undefined;
    }
  });

  let subscriber: ((frame: Record<string, unknown>) => void) | null = null;
  let detached = false;
  const runtime = {
    trigger: vi.fn(async () => ({ ok: true as const, runId: 'run-1' })),
    cancel: vi.fn(() => ({ ok: true })),
    listRuns: vi.fn(() => [{ runId: 'run-1', workflowName: 'digest', status: 'running', startedAt: 1 }]),
    resolvePermission: vi.fn(() => ({ ok: true })),
    attach: vi.fn((_runId: string, _afterSeq: number, write: (f: Record<string, unknown>) => void) => {
      if (!attach) return null;
      subscriber = write;
      return () => {
        detached = true;
      };
    }),
    push: (frame: Record<string, unknown>) => subscriber?.(frame),
    detached: () => detached,
  };

  const deps = {
    sessionManager: new SessionManager(),
    workerManager: { workerCount: 0 } as unknown as RouterDeps['workerManager'],
    checkpointBatcher: { flush: () => {} } as unknown as RouterDeps['checkpointBatcher'],
    logger: silent(),
    httpLogger: silent(),
    sessionLogger: silent(),
    dbRequest: dbRequest as unknown as RouterDeps['dbRequest'],
    ...(withRuntime ? { workflowRuntimeManager: runtime as unknown as RouterDeps['workflowRuntimeManager'] } : {}),
  } as RouterDeps;

  const handler = createHandleRequest(deps, new Map<string, ChildProcess>(), new Set(), () => false);
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    dbRequest,
    runtime,
  };
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
});

describe('workflow-runtime routes', () => {
  it('lists live runs for diagnostics', async () => {
    active = await startServer();
    const res = await fetch(`${active.url}/workflow-runtime/runs`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      runs: [expect.objectContaining({ runId: 'run-1' })],
    });
  });

  it('triggers with the resolved active provider and returns the runId', async () => {
    active = await startServer();
    const res = await fetch(`${active.url}/workflow-runtime/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'digest', projectDir: 'E:/proj', params: { t: 1 } }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, runId: 'run-1' });
    expect(active.runtime.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'digest',
        projectDir: 'E:/proj',
        params: { t: 1 },
        scope: null,
        // A run has no session row to read a model from, so the active provider
        // is the only source (§5.2).
        llm: expect.objectContaining({ model: 'm1', apiKey: 'k', provider: 'openai' }),
      }),
    );
  });

  it('rejects a nameless trigger and reports a capacity refusal verbatim', async () => {
    active = await startServer();
    const bad = await fetch(`${active.url}/workflow-runtime/trigger`, {
      method: 'POST',
      body: JSON.stringify({ projectDir: 'E:/proj' }),
    });
    expect(bad.status).toBe(400);

    active.runtime.trigger.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'workflow runtime is at capacity (3/3 runs in flight)',
    });
    const refused = await fetch(`${active.url}/workflow-runtime/trigger`, {
      method: 'POST',
      body: JSON.stringify({ name: 'digest' }),
    });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('capacity') });
  });

  it('answers 503 when no LLM provider is configured', async () => {
    active = await startServer();
    active.dbRequest.mockImplementation(async (action: string) =>
      action === 'config:provider:getActive' ? null : undefined,
    );
    const res = await fetch(`${active.url}/workflow-runtime/trigger`, {
      method: 'POST',
      body: JSON.stringify({ name: 'digest' }),
    });
    expect(res.status).toBe(503);
    expect(active.runtime.trigger).not.toHaveBeenCalled();
  });

  it('routes cancel to the manager', async () => {
    active = await startServer();
    const ok = await fetch(`${active.url}/workflow-runtime/run-1/cancel`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(active.runtime.cancel).toHaveBeenCalledWith('run-1');

    active.runtime.cancel.mockReturnValueOnce({ ok: false, error: 'run is not active in this process' });
    const missing = await fetch(`${active.url}/workflow-runtime/nope/cancel`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it('streams live frames from the manager and closes on the terminal frame', async () => {
    active = await startServer({ attach: true });
    const responsePromise = fetch(`${active.url}/workflow-runtime/run-1/events?afterSeq=3`);

    // The manager accepted the cursor — the route must not fall back to the DB.
    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(active.runtime.attach).toHaveBeenCalledWith('run-1', 3, expect.any(Function));

    active.runtime.push({ frame: 'record', runId: 'run-1', seq: 4, record: { seq: 4, kind: 'node_result' } });
    active.runtime.push({ frame: 'done', runId: 'run-1', summary: { runId: 'run-1', status: 'complete', artifacts: [] } });

    const body = await res.text();
    expect(body).toContain('event: record\nid: 4\ndata: {"frame":"record"');
    expect(body).toContain('event: done\n');
    // Terminal frames carry no journal cursor, so they must not claim an SSE id.
    expect(body).not.toContain('event: done\nid:');
    expect(active.runtime.detached()).toBe(true);
  });

  it('replays a finished run from the events table, past the requested cursor', async () => {
    active = await startServer({ attach: false });
    const res = await fetch(`${active.url}/workflow-runtime/run-1/events?afterSeq=0`);
    const body = await res.text();

    expect(active.runtime.attach).toHaveBeenCalled();
    expect(active.dbRequest).toHaveBeenCalledWith('workflowRun:listEvents', { runId: 'run-1', afterSeq: 0 });
    expect(body).toContain('event: record\nid: 0\n');
    expect(body).toContain('event: record\nid: 1\n');
    // The terminal rollup is reconstructed from the row, so a session that was
    // closed when the run finished still renders a complete card.
    expect(body).toContain('"frame":"done"');
    expect(body).toContain('"status":"complete"');
    expect(body).toContain('"spentTokens"'.replace('spentTokens', 'tokens'));
    expect(body).toContain('"bytes":5');
  });

  it('routes an approval decision to the run that asked for it', async () => {
    active = await startServer();
    const ok = await fetch(`${active.url}/workflow-runtime/run-1/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-7', decision: 'allow' }),
    });
    expect(ok.status).toBe(200);
    expect(active.runtime.resolvePermission).toHaveBeenCalledWith('run-1', 'req-7', 'allow');

    // A decision that is not an explicit allow must not become one.
    await fetch(`${active.url}/workflow-runtime/run-1/permission`, {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-8', decision: 'maybe' }),
    });
    expect(active.runtime.resolvePermission).toHaveBeenLastCalledWith('run-1', 'req-8', 'deny');

    const nameless = await fetch(`${active.url}/workflow-runtime/run-1/permission`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(nameless.status).toBe(400);

    active.runtime.resolvePermission.mockReturnValueOnce({ ok: false, error: 'run is not active in this process' });
    const missing = await fetch(`${active.url}/workflow-runtime/gone/permission`, {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-9', decision: 'allow' }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not active') });
  });

  it('answers 503 when the runtime is not wired into this server', async () => {
    active = await startServer({ withRuntime: false });
    const res = await fetch(`${active.url}/workflow-runtime/runs`);
    expect(res.status).toBe(503);
  });
});

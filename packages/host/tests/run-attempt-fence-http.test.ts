/**
 * The attempt fence across the HTTP boundary, on the REAL route handler.
 *
 * ## Why this file exists
 *
 * `HostRunApiV1.appendAgentRunEvents`/`settleAgentRun` declared `epoch?: number`
 * and the HTTP client built a body of `{ events }` / `{ terminal, metrics }` — so
 * the fence was dropped on the client, absent on the server route, and a write
 * over HTTP was unfenced at BOTH ends while still looking like a fenced one. A
 * closure-level test cannot see that: both ends can be individually "correct"
 * and the wire still carry nothing. So every case here goes through
 * `HostSessionHttpServer`'s own route handler over a real socket.
 *
 * ## What the negative cases assert
 *
 * A body with no `fence` is a 400 and the api is NEVER called. That second half
 * is the load-bearing one: a route that answers 400 after writing would still
 * pass a status-only assertion while having done the unfenced write it refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HostRunApiV1,
  RunAttemptFence,
  RunEventEnvelope,
  RunId,
  SettleAgentRunResult,
  UnfencedRunWriteAuthorization,
} from '@duya/agent-protocol';
import { HostSessionHttpClient, HostSessionHttpError } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { HostRunApiError } from '../src/run-api.js';

const RUN_ID = 'run_fence_wire' as RunId;
const SESSION_ID = 'session_fence_wire';
const TOKEN = 'test-token';

interface RecordedWrite {
  readonly method: 'fenced' | 'unfenced';
  readonly fence?: RunAttemptFence;
  readonly authorization?: UnfencedRunWriteAuthorization;
  readonly terminal?: unknown;
}

/**
 * A recording stand-in for storage.
 *
 * It records the authority that ARRIVED, which is the only thing this boundary
 * can be asked about: whether the attempt the caller presented is the attempt the
 * Host is about to write under.
 */
function createRecordingRunApi(): { api: HostRunApiV1; writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];
  const api = {
    async appendAgentRunEvents(_runId: RunId, _events: readonly RunEventEnvelope[], fence: RunAttemptFence) {
      writes.push({ method: 'fenced', fence });
      return 1;
    },
    async settleAgentRun(_runId: RunId, terminal: unknown, fence: RunAttemptFence): Promise<SettleAgentRunResult> {
      writes.push({ method: 'fenced', fence, terminal });
      return { state: 'applied' };
    },
    async appendAgentRunEventsUnfenced(
      _runId: RunId,
      _events: readonly RunEventEnvelope[],
      authorization: UnfencedRunWriteAuthorization,
    ) {
      writes.push({ method: 'unfenced', authorization });
      return 1;
    },
    async settleAgentRunUnfenced(
      _runId: RunId,
      terminal: unknown,
      authorization: UnfencedRunWriteAuthorization,
    ): Promise<SettleAgentRunResult> {
      writes.push({ method: 'unfenced', authorization, terminal });
      return { state: 'applied' };
    },
  } as unknown as HostRunApiV1;
  return { api, writes };
}

function envelope(seq = 1): RunEventEnvelope {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-1',
    payload: { type: 'message.delta' },
  } as unknown as RunEventEnvelope;
}

describe('the run attempt fence over HTTP', () => {
  let server: HostSessionHttpServer;
  let client: HostSessionHttpClient;
  let writes: RecordedWrite[];
  let origin: string;

  beforeEach(async () => {
    const recording = createRecordingRunApi();
    writes = recording.writes;
    server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: recording.api,
    });
    await server.listen();
    origin = `http://127.0.0.1:${server.port}`;
    client = new HostSessionHttpClient(origin, TOKEN);
  });

  afterEach(async () => {
    await server.close();
  });

  /** A raw request, so the body under test is the body on the wire. */
  const post = async (suffix: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/v1/agent-runs/${encodeURIComponent(RUN_ID)}${suffix}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  it('carries the presented attempt to storage on both write routes', async () => {
    const fence: RunAttemptFence = { epoch: 7, writer: 'test/writer' };

    await client.appendAgentRunEvents(RUN_ID, [envelope()], fence);
    await client.settleAgentRun(RUN_ID, { status: 'completed' }, fence);

    expect(writes.map((write) => write.method)).toEqual(['fenced', 'fenced']);
    expect(writes.map((write) => write.fence)).toEqual([fence, fence]);
  });

  it('refuses an append that presents no attempt, and writes nothing', async () => {
    const refused = await post('/events', { events: [envelope()] });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: { code: 'invalid_run_attempt_fence' } });
    expect(writes).toEqual([]);
  });

  it('refuses the bare `epoch` shape the old contract used, rather than reading it as a fence', async () => {
    const refused = await post('/events', { events: [envelope()], epoch: 3 });

    expect(refused.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('refuses a settle that presents no attempt, and writes nothing', async () => {
    const refused = await post('/terminal', { terminal: { status: 'completed' } });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: { code: 'invalid_run_attempt_fence' } });
    expect(writes).toEqual([]);
  });

  it.each([
    ['a string epoch', { epoch: '3', writer: 'test/writer' }],
    ['a fractional epoch', { epoch: 1.5, writer: 'test/writer' }],
    ['a negative epoch', { epoch: -1, writer: 'test/writer' }],
    ['a missing writer', { epoch: 3 }],
    ['a blank writer', { epoch: 3, writer: '   ' }],
  ])('refuses a fence with %s', async (_label, fence) => {
    const refused = await post('/events', { events: [envelope()], fence });

    expect(refused.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('refuses a body that claims both a fence and an unfenced authorization', async () => {
    const refused = await post('/events', {
      events: [envelope()],
      fence: { epoch: 3, writer: 'test/writer' },
      unfenced: { reason: 'backfill', authorizedBy: 'operator' },
    });

    expect(refused.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('refuses an unfenced authorization it cannot read', async () => {
    const refused = await post('/events', {
      events: [envelope()],
      unfenced: { reason: 'backfill' },
    });

    expect(refused.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('reaches the unfenced path only when it is named, with its authorization', async () => {
    const authorization: UnfencedRunWriteAuthorization = { reason: 'bulk backfill', authorizedBy: 'operator' };

    await client.appendAgentRunEventsUnfenced(RUN_ID, [envelope()], authorization);
    await client.settleAgentRunUnfenced(RUN_ID, { status: 'completed' }, authorization);

    expect(writes).toEqual([
      { method: 'unfenced', authorization },
      { method: 'unfenced', authorization, terminal: { status: 'completed' } },
    ]);
  });

  it('surfaces a fenced append refusal across the wire, distinct from a conflict', async () => {
    const refusing = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: {
        async appendAgentRunEvents(): Promise<number> {
          throw new HostRunApiError(409, 'attempt_fenced', 'run is on attempt 2', { presented: 1, current: 2 });
        },
      } as unknown as HostRunApiV1,
    });
    await refusing.listen();
    try {
      const refusingClient = new HostSessionHttpClient(`http://127.0.0.1:${refusing.port}`, TOKEN);

      const error = await refusingClient
        .appendAgentRunEvents(RUN_ID, [envelope()], { epoch: 1, writer: 'test/writer' })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(HostSessionHttpError);
      const fenced = error as HostSessionHttpError;
      expect(fenced.status).toBe(409);
      expect(fenced.code).toBe('attempt_fenced');
      // The attempt pair has to survive the hop: without it the caller cannot
      // tell this refusal from a conflict, and the two have opposite remedies.
      expect(fenced.fenced).toEqual({ presented: 1, current: 2 });
    } finally {
      await refusing.close();
    }
  });

  it('round trips a fenced settle outcome as `fenced`, not as `conflict`', async () => {
    const refusing = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: {
        async settleAgentRun(): Promise<SettleAgentRunResult> {
          return { state: 'fenced', presented: 1, current: 4 };
        },
      } as unknown as HostRunApiV1,
    });
    await refusing.listen();
    try {
      const refusingClient = new HostSessionHttpClient(`http://127.0.0.1:${refusing.port}`, TOKEN);

      const outcome = await refusingClient.settleAgentRun(
        RUN_ID,
        { status: 'completed' },
        { epoch: 1, writer: 'test/writer' },
      );

      expect(outcome).toEqual({ state: 'fenced', presented: 1, current: 4 });
      expect(outcome.state).not.toBe('conflict');
    } finally {
      await refusing.close();
    }
  });
});

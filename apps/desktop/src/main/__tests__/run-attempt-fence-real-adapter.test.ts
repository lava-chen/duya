/**
 * The attempt fence as the `db:request` path actually delivers it.
 *
 * ## Why the whole chain is real here
 *
 * `createDesktopHostRunApiAdapter` used to read the caller's `epoch` with a
 * helper that turned anything unreadable into `undefined`, and storage reads
 * `undefined` as a deliberate unfenced write. So a `run:append` whose attempt
 * was missing — or malformed, or sent as the string `'3'` — reached the table as
 * an unfenced write that looked exactly like a fenced one. Asserting the adapter
 * against a fake api proves nothing about that, because the fake cannot be
 * confused the way storage can.
 *
 * So: the real adapter, over a real `HostSessionHttpClient`, into the real
 * `HostSessionHttpServer` route handler, into the real `createHostRunApi`, onto a
 * recording repository. The repository records the epoch it was HANDED, which is
 * the only claim this boundary is entitled to make.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { RunEpochFencedError, type RunRow } from '@duya/data/run-store';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '@duya/host/http-server';
import { createHostRunApi } from '@duya/host/run-api';
import { readRunReceipt } from '@duya/host/run-receipt';

import { createDesktopHostRunApiAdapter } from '../control-plane/host-run-api-adapter';

const RUN_ID = 'run_adapter_fence' as RunId;
const SESSION_ID = 'session_adapter_fence';
const TOKEN = 'test-token';

type RecordedWrite =
  | { readonly method: 'append'; readonly epoch: number | undefined }
  | { readonly method: 'settle'; readonly epoch: number | undefined };

function runRow(): RunRow {
  return {
    id: RUN_ID,
    session_id: SESSION_ID,
    manifest_hash: 'hash',
    manifest_json: JSON.stringify({ runId: RUN_ID }),
    input_hash: 'input',
    epoch: 1,
    status: 'running',
    terminal: null,
    error_json: null,
    metrics_json: null,
    origin: 'user',
    parent_run_id: null,
    created_at: 1_700_000_000_000,
    started_at: 1_700_000_000_000,
    finished_at: null,
  };
}

function envelope(): RunEventEnvelope {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-1',
    payload: { type: 'message.delta' },
  } as unknown as RunEventEnvelope;
}

describe('the run attempt fence through the desktop db:request adapter', () => {
  let server: HostSessionHttpServer;
  let adapter: ReturnType<typeof createDesktopHostRunApiAdapter>;
  let writes: RecordedWrite[];

  beforeEach(async () => {
    writes = [];
    const runs = {
      getRun: () => runRow(),
      appendEvents: (_events: readonly RunEventEnvelope[], epoch?: number) => {
        writes.push({ method: 'append', epoch });
        return 1;
      },
      settleRun: (_runId: string, _terminal: unknown, _metrics: unknown, epoch?: number) => {
        writes.push({ method: 'settle', epoch });
        return { state: 'applied' } as const;
      },
    };

    server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: createHostRunApi({ runs } as unknown as Parameters<typeof createHostRunApi>[0]),
    });
    await server.listen();
    const client = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, TOKEN);
    adapter = createDesktopHostRunApiAdapter(client);
  });

  afterEach(async () => {
    await server.close();
  });

  it('delivers the attempt the writer presented, on both write actions', async () => {
    await adapter('run:append', { runId: RUN_ID, events: [envelope()], epoch: 3 });
    await adapter('run:complete', { runId: RUN_ID, terminal: { status: 'completed' }, epoch: 3 });

    expect(writes).toEqual([
      { method: 'append', epoch: 3 },
      { method: 'settle', epoch: 3 },
    ]);
  });

  it('refuses a run:append that presents no attempt, and never reaches storage', async () => {
    const reply = await adapter('run:append', { runId: RUN_ID, events: [envelope()] });
    const receipt = readRunReceipt(reply, 'run:append', RUN_ID);

    expect(receipt.state).toBe('invalid');
    // Names the writer, because a refusal that cannot name its subject is the
    // incident this whole fence contract exists to prevent.
    expect(receipt.state === 'invalid' ? receipt.reason : '').toContain('desktop/host-run-api-adapter');
    expect(writes).toEqual([]);
  });

  it('refuses a run:complete that presents no attempt, and never reaches storage', async () => {
    const reply = await adapter('run:complete', { runId: RUN_ID, terminal: { status: 'completed' } });
    const receipt = readRunReceipt(reply, 'run:complete', RUN_ID);

    expect(receipt.state).toBe('invalid');
    expect(writes).toEqual([]);
  });

  it.each([
    ['a string epoch', '3'],
    ['a fractional epoch', 1.5],
    ['a negative epoch', -1],
    ['null', null],
  ])('refuses %s rather than writing unfenced', async (_label, epoch) => {
    const reply = await adapter('run:append', { runId: RUN_ID, events: [envelope()], epoch });
    const receipt = readRunReceipt(reply, 'run:append', RUN_ID);

    expect(receipt.state).toBe('invalid');
    expect(writes).toEqual([]);
  });

  it('reports a fenced append as `fenced`, not as a conflict, across the whole chain', async () => {
    const fenced = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: createHostRunApi({
        runs: {
          getRun: () => runRow(),
          appendEvents: () => {
            throw new RunEpochFencedError(RUN_ID, 1, 2);
          },
        },
      } as unknown as Parameters<typeof createHostRunApi>[0]),
    });
    await fenced.listen();
    try {
      const fencedAdapter = createDesktopHostRunApiAdapter(
        new HostSessionHttpClient(`http://127.0.0.1:${fenced.port}`, TOKEN),
      );

      const reply = await fencedAdapter('run:append', { runId: RUN_ID, events: [envelope()], epoch: 1 });
      const receipt = readRunReceipt(reply, 'run:append', RUN_ID);

      expect(receipt.state).toBe('fenced');
      expect(receipt).toMatchObject({ presented: 1, current: 2 });
      // The distinction is the whole point: `conflict` would send this caller
      // looking for a rival writer that does not exist.
      expect(receipt.state).not.toBe('conflict');
    } finally {
      await fenced.close();
    }
  });

  it('still reports a lost terminal CAS as a conflict, so the two stay distinguishable', async () => {
    const conflicted = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      runApi: createHostRunApi({
        runs: {
          getRun: () => runRow(),
          settleRun: () => ({ state: 'conflict', committed: { status: 'cancelled' } }),
        },
      } as unknown as Parameters<typeof createHostRunApi>[0]),
    });
    await conflicted.listen();
    try {
      const conflictedAdapter = createDesktopHostRunApiAdapter(
        new HostSessionHttpClient(`http://127.0.0.1:${conflicted.port}`, TOKEN),
      );

      const reply = await conflictedAdapter('run:complete', {
        runId: RUN_ID,
        terminal: { status: 'completed' },
        epoch: 1,
      });
      const receipt = readRunReceipt(reply, 'run:complete', RUN_ID);

      expect(receipt.state).toBe('conflict');
      expect(receipt).toMatchObject({ committed: { status: 'cancelled' } });
    } finally {
      await conflicted.close();
    }
  });
});
